// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! An in-process SSH server for the integration tests: password and keyboard-interactive login
//! (password "secret"), an echo shell, exec channels that run real commands in a folder, a
//! minimal SFTP subsystem, direct-tcpip tunnels and tcpip-forward.

use parking_lot::Mutex;
use russh::keys::{Algorithm, PrivateKey};
use russh::server::{Auth, Msg, Response, Server as _, Session};
use russh::{Channel, ChannelId, ChannelMsg, MethodKind, MethodSet};
use russh_sftp::protocol::{File, FileAttributes, Handle, Name, Status, StatusCode, Version};
use std::borrow::Cow;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use tokio::io::{AsyncReadExt, AsyncWriteExt};

#[derive(Default)]
pub struct Stats {
    pub tunnels: AtomicUsize,
    pub execs: Mutex<Vec<String>>,
}

pub struct TestServer {
    pub port: u16,
    pub stats: Arc<Stats>,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for TestServer {
    fn drop(&mut self) {
        self.task.abort();
    }
}

#[derive(Clone)]
struct Server {
    root: PathBuf,
    stats: Arc<Stats>,
}

struct Conn {
    root: PathBuf,
    stats: Arc<Stats>,
    channels: HashMap<ChannelId, Channel<Msg>>,
}

impl russh::server::Server for Server {
    type Handler = Conn;
    fn new_client(&mut self, _: Option<std::net::SocketAddr>) -> Conn {
        Conn { root: self.root.clone(), stats: self.stats.clone(), channels: HashMap::new() }
    }
}

fn methods() -> MethodSet {
    MethodSet::from(&[MethodKind::Password, MethodKind::KeyboardInteractive][..])
}

fn reject() -> Auth {
    Auth::Reject { proceed_with_methods: Some(methods()), partial_success: false }
}

impl russh::server::Handler for Conn {
    type Error = russh::Error;

    async fn auth_none(&mut self, _user: &str) -> Result<Auth, Self::Error> {
        Ok(reject())
    }

    async fn auth_password(&mut self, user: &str, password: &str) -> Result<Auth, Self::Error> {
        Ok(if password == "secret" && ["tester", "u", "j"].contains(&user) { Auth::Accept } else { reject() })
    }

    async fn auth_keyboard_interactive<'a>(&'a mut self, user: &str, _sub: &str, response: Option<Response<'a>>) -> Result<Auth, Self::Error> {
        match response {
            None => {
                Ok(Auth::Partial { name: Cow::Borrowed(""), instructions: Cow::Borrowed(""), prompts: Cow::Owned(vec![(Cow::Borrowed("Password: "), false)]) })
            }
            Some(mut r) => {
                let answer = r.next().map(|b| String::from_utf8_lossy(&b).into_owned()).unwrap_or_default();
                Ok(if user == "tester" && answer == "secret" { Auth::Accept } else { reject() })
            }
        }
    }

    async fn channel_open_session(
        &mut self,
        channel: Channel<Msg>,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.channels.insert(channel.id(), channel);
        reply.accept().await;
        Ok(())
    }

    async fn pty_request(
        &mut self,
        channel: ChannelId,
        _term: &str,
        _c: u32,
        _r: u32,
        _pw: u32,
        _ph: u32,
        _modes: &[(russh::Pty, u32)],
        session: &mut Session,
    ) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn window_change_request(&mut self, channel: ChannelId, _c: u32, _r: u32, _pw: u32, _ph: u32, session: &mut Session) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        Ok(())
    }

    async fn shell_request(&mut self, channel: ChannelId, session: &mut Session) -> Result<(), Self::Error> {
        session.channel_success(channel)?;
        let Some(ch) = self.channels.remove(&channel) else { return Ok(()) };
        let (mut read, write) = ch.split();
        tokio::spawn(async move {
            let _ = write.data_bytes(b"Welcome\r\n$ ".to_vec()).await;
            while let Some(m) = read.wait().await {
                match m {
                    ChannelMsg::Data { data } => {
                        let s = String::from_utf8_lossy(&data).to_string();
                        if s.contains("exit") {
                            let _ = write.exit_status(0).await;
                            let _ = write.eof().await;
                            let _ = write.close().await;
                            break;
                        }
                        let _ = write.data_bytes(format!("echo:{}\r\n$ ", s.trim()).into_bytes()).await;
                    }
                    ChannelMsg::Eof | ChannelMsg::Close => break,
                    _ => {}
                }
            }
        });
        Ok(())
    }

    async fn exec_request(&mut self, channel: ChannelId, data: &[u8], session: &mut Session) -> Result<(), Self::Error> {
        let cmd = String::from_utf8_lossy(data).into_owned();
        self.stats.execs.lock().push(cmd.clone());
        session.channel_success(channel)?;
        let Some(ch) = self.channels.remove(&channel) else { return Ok(()) };
        let root = self.root.clone();
        tokio::spawn(async move {
            let mut child = tokio::process::Command::new("/bin/sh")
                .arg("-c")
                .arg(&cmd)
                .current_dir(&root)
                .env("HOME", &root)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .kill_on_drop(true)
                .spawn()
                .unwrap();
            let mut stdin = child.stdin.take().unwrap();
            let mut stdout = child.stdout.take().unwrap();
            let mut stderr = child.stderr.take().unwrap();
            let (mut read, write) = ch.split();
            let write = Arc::new(write);
            let w2 = write.clone();
            let out = tokio::spawn(async move {
                let mut buf = vec![0u8; 32768];
                while let Ok(n) = stdout.read(&mut buf).await {
                    if n == 0 || w2.data_bytes(buf[..n].to_vec()).await.is_err() {
                        break;
                    }
                }
            });
            let w3 = write.clone();
            let err = tokio::spawn(async move {
                let mut buf = vec![0u8; 4096];
                while let Ok(n) = stderr.read(&mut buf).await {
                    if n == 0 || w3.extended_data_bytes(1, buf[..n].to_vec()).await.is_err() {
                        break;
                    }
                }
            });
            let input = tokio::spawn(async move {
                while let Some(m) = read.wait().await {
                    match m {
                        ChannelMsg::Data { data } => {
                            if stdin.write_all(&data).await.is_err() {
                                break;
                            }
                        }
                        ChannelMsg::Eof | ChannelMsg::Close => break,
                        _ => {}
                    }
                }
                drop(stdin);
            });
            let status = child.wait().await.ok().and_then(|s| s.code()).unwrap_or(1);
            let _ = out.await;
            let _ = err.await;
            input.abort();
            let _ = write.exit_status(status as u32).await;
            let _ = write.eof().await;
            let _ = write.close().await;
        });
        Ok(())
    }

    async fn subsystem_request(&mut self, channel: ChannelId, name: &str, session: &mut Session) -> Result<(), Self::Error> {
        if name == "sftp" {
            if let Some(ch) = self.channels.remove(&channel) {
                session.channel_success(channel)?;
                tokio::spawn(russh_sftp::server::run(ch.into_stream(), Sftp::default()));
                return Ok(());
            }
        }
        session.channel_failure(channel)?;
        Ok(())
    }

    async fn channel_open_direct_tcpip(
        &mut self,
        channel: Channel<Msg>,
        host: &str,
        port: u32,
        _oa: &str,
        _op: u32,
        reply: russh::server::ChannelOpenHandle,
        _session: &mut Session,
    ) -> Result<(), Self::Error> {
        self.stats.tunnels.fetch_add(1, Ordering::SeqCst);
        let host = host.to_string();
        tokio::spawn(async move {
            match tokio::net::TcpStream::connect((host.as_str(), port as u16)).await {
                Ok(mut sock) => {
                    reply.accept().await;
                    let mut st = channel.into_stream();
                    let _ = tokio::io::copy_bidirectional(&mut st, &mut sock).await;
                }
                Err(_) => reply.reject(russh::ChannelOpenFailure::ConnectFailed).await,
            }
        });
        Ok(())
    }

    async fn tcpip_forward(&mut self, _address: &str, _port: &mut u32, _session: &mut Session) -> Result<bool, Self::Error> {
        Ok(true)
    }
}

/// Minimal SFTP: REALPATH and a directory listing with one file.
#[derive(Default)]
struct Sftp {
    listed: bool,
}

impl russh_sftp::server::Handler for Sftp {
    type Error = StatusCode;
    fn unimplemented(&self) -> Self::Error {
        StatusCode::OpUnsupported
    }
    async fn init(&mut self, _version: u32, _ext: HashMap<String, String>) -> Result<Version, Self::Error> {
        Ok(Version::new())
    }
    async fn realpath(&mut self, id: u32, _path: String) -> Result<Name, Self::Error> {
        Ok(Name { id, files: vec![File::dummy("/home/tester")] })
    }
    async fn opendir(&mut self, id: u32, path: String) -> Result<Handle, Self::Error> {
        self.listed = false;
        Ok(Handle { id, handle: path })
    }
    async fn readdir(&mut self, id: u32, _handle: String) -> Result<Name, Self::Error> {
        if self.listed {
            return Err(StatusCode::Eof);
        }
        self.listed = true;
        let attrs = FileAttributes {
            size: Some(12),
            permissions: Some(0o100644),
            mtime: Some(1700000000),
            atime: Some(0),
            uid: Some(0),
            gid: Some(0),
            ..FileAttributes::empty()
        };
        Ok(Name { id, files: vec![File::new("notes.txt", attrs)] })
    }
    async fn close(&mut self, id: u32, _handle: String) -> Result<Status, Self::Error> {
        Ok(Status { id, status_code: StatusCode::Ok, error_message: "Ok".into(), language_tag: "en-US".into() })
    }
}

pub async fn start(root: PathBuf) -> TestServer {
    let config = russh::server::Config {
        auth_rejection_time: std::time::Duration::from_millis(0),
        auth_rejection_time_initial: Some(std::time::Duration::from_millis(0)),
        keys: vec![PrivateKey::random(&mut rand::rng(), Algorithm::Ed25519).unwrap()],
        ..Default::default()
    };
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = listener.local_addr().unwrap().port();
    let stats = Arc::new(Stats::default());
    let mut server = Server { root, stats: stats.clone() };
    let config = Arc::new(config);
    let task = tokio::spawn(async move {
        let _ = server.run_on_socket(config, &listener).await;
    });
    TestServer { port, stats, task }
}

/// A TCP echo server.
pub async fn echo_server() -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                let (mut r, mut w) = s.split();
                let _ = tokio::io::copy(&mut r, &mut w).await;
            });
        }
    });
    port
}
