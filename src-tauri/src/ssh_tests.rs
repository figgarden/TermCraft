// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! Integration tests: TermCraft's SSH client, connection manager, SFTP and SCP against the
//! in-process SSH server.

use crate::bus::Bus;
use crate::conn_manager::Manager;
use crate::json::truthy;
use crate::proto::ssh::{Mode, SshClient, connect_client, open_shell};
use crate::proto::{Ctx, Event};
use crate::scp::Exec;
use crate::sftp_service::SftpService;
use crate::store::Store;
use crate::store::tests::tmp;
use crate::test_ssh_server::{echo_server, start};
use parking_lot::Mutex;
use serde_json::{Value, json};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::mpsc;

fn resolve(store: &Arc<Mutex<Store>>, r: &Value) -> anyhow::Result<Value> {
    store.lock().resolve_session(r)
}

fn store() -> Arc<Mutex<Store>> {
    Arc::new(Mutex::new(Store::new(&tmp("ssh"), None).unwrap()))
}

/// A prompt handler that records the kinds asked and answers with `answer`.
fn ctx(store: &Arc<Mutex<Store>>, answer: impl Fn(&Value) -> Value + Send + Sync + 'static) -> (Ctx, Arc<Mutex<Vec<String>>>) {
    let asked: Arc<Mutex<Vec<String>>> = Default::default();
    let a = asked.clone();
    let answer = Arc::new(answer);
    (
        Ctx {
            store: store.clone(),
            prompt: Arc::new(move |req: Value| {
                a.lock().push(req["kind"].as_str().unwrap_or("").to_string());
                let v = answer(&req);
                Box::pin(async move { v })
            }),
        },
        asked,
    )
}

async fn free_port() -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    l.local_addr().unwrap().port()
}

async fn read_until(rx: &mut mpsc::UnboundedReceiver<Event>, needle: &str) -> String {
    let mut out = String::new();
    while !out.contains(needle) {
        match tokio::time::timeout(Duration::from_secs(5), rx.recv()).await {
            Ok(Some(Event::Data(d))) => out.push_str(&String::from_utf8_lossy(&d)),
            Ok(Some(_)) => {}
            _ => panic!("timed out waiting for {needle:?}; got {out:?}"),
        }
    }
    out
}

#[tokio::test]
async fn password_auth_host_key_shell_forwards_sftp() {
    let server = start(tmp("root")).await;
    let echo = echo_server().await;
    let store = store();
    let (l_port, d_port) = (free_port().await, free_port().await);
    let session = store
        .lock()
        .resolve_session(&json!({
            "name": "test", "protocol": "ssh2", "host": "127.0.0.1", "port": server.port, "username": "tester",
            "auth": { "methods": ["password"], "useAgent": false },
            "forwards": [
                { "type": "L", "bindHost": "127.0.0.1", "bindPort": l_port, "destHost": "127.0.0.1", "destPort": echo },
                { "type": "D", "bindHost": "127.0.0.1", "bindPort": d_port },
            ],
        }))
        .unwrap();
    let (c, prompts) = ctx(&store, |req| match req["kind"].as_str() {
        Some("hostkey") => json!("save"),
        Some("password") => json!("secret"),
        _ => Value::Null,
    });
    let (ev, mut rx) = mpsc::unbounded_channel();
    let conn = open_shell(session.clone(), c.clone(), 80, 24, ev).await.unwrap();
    assert_eq!(*prompts.lock(), vec!["hostkey", "password"]);
    assert!(store.lock().known_host(&format!("127.0.0.1:{}", server.port)).unwrap()["fingerprint"].as_str().unwrap().starts_with("SHA256:"));
    conn.write(b"hello\r".to_vec());
    let out = read_until(&mut rx, "echo:hello").await;
    assert!(out.contains("Welcome"));

    // Local forward round-trip.
    tokio::time::sleep(Duration::from_millis(200)).await;
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", l_port)).await.unwrap();
    s.write_all(b"ping").await.unwrap();
    let mut buf = [0u8; 4];
    s.read_exact(&mut buf).await.unwrap();
    assert_eq!(&buf, b"ping");

    // Dynamic (SOCKS5) forward round-trip.
    let mut s = tokio::net::TcpStream::connect(("127.0.0.1", d_port)).await.unwrap();
    s.write_all(&[5, 1, 0]).await.unwrap();
    let mut g = [0u8; 2];
    s.read_exact(&mut g).await.unwrap();
    s.write_all(&[5, 1, 0, 1, 127, 0, 0, 1, (echo >> 8) as u8, echo as u8]).await.unwrap();
    let mut r = [0u8; 10];
    s.read_exact(&mut r).await.unwrap();
    assert_eq!(r[1], 0);
    s.write_all(b"socks!").await.unwrap();
    let mut b6 = [0u8; 6];
    s.read_exact(&mut b6).await.unwrap();
    assert_eq!(&b6, b"socks!");
    conn.close();

    // Second connect: known host, no host key prompt.
    prompts.lock().clear();
    let mut s2 = session.clone();
    s2["forwards"] = json!([]);
    let (ev, _rx) = mpsc::unbounded_channel();
    let c2 = connect_client(s2.clone(), c.clone(), ev, Mode::Tunnel).await.unwrap();
    assert_eq!(*prompts.lock(), vec!["password"]);
    c2.close();

    // SFTP listing through the service.
    let (bus, _) = Bus::fake(|_, req| match req["kind"].as_str() {
        Some("password") => json!("secret"),
        Some("hostkey") => json!("once"),
        _ => Value::Null,
    });
    let sftp = SftpService::new(bus, store.clone());
    let info = sftp.open("x", &s2).await.unwrap();
    assert_eq!(info["home"], "/home/tester");
    let list = sftp.list_remote("x", "/home/tester").await.unwrap();
    let entries: Vec<Value> = list["entries"].as_array().unwrap().iter().map(|e| json!([e["name"], e["size"], e["mode"]])).collect();
    assert_eq!(entries, vec![json!(["notes.txt", 12, "-rw-r--r--"])]);
    sftp.close_all();
}

#[tokio::test]
async fn manager_logon_actions_wait_for_and_logging() {
    let server = start(tmp("root")).await;
    let dir = tmp("mgr");
    let store = Arc::new(Mutex::new(Store::new(&dir, None).unwrap()));
    let log_file = dir.join("session.log");
    let s = store
        .lock()
        .save_session(&json!({
            "name": "m", "protocol": "ssh2", "host": "127.0.0.1", "port": server.port, "username": "tester",
            "auth": { "methods": ["password"], "useAgent": false, "password": "secret" },
            "logonActions": [{ "expect": "Welcome", "send": "auto\\r" }],
            "logging": { "enabled": true, "path": log_file.to_string_lossy(), "timestamps": true },
        }))
        .unwrap();
    let (bus, events) = Bus::fake(|_, req| if req["kind"] == "hostkey" { json!("once") } else { Value::Null });
    let mgr = Manager::new(bus, store);
    let m2 = mgr.clone();
    let id = s["id"].clone();
    let waiting = tokio::spawn(async move {
        m2.open("tab1", &id, 80, 24).await.unwrap();
        m2.wait_for("tab1", vec!["echo:auto".into()], 3000).await
    });
    let r = waiting.await.unwrap();
    assert_eq!(r.0, 0, "logon action should have sent \"auto\"");
    let m3 = mgr.clone();
    let w = tokio::spawn(async move { m3.wait_for("tab1", vec!["nope".into(), "echo:x".into()], 3000).await });
    tokio::time::sleep(Duration::from_millis(50)).await;
    mgr.write("tab1", "x\r", false);
    assert_eq!(w.await.unwrap().0, 1);
    assert_eq!(mgr.wait_for("tab1", vec!["never".into()], 100).await.0, -1);
    mgr.close("tab1", false);
    tokio::time::sleep(Duration::from_millis(100)).await;
    let log = std::fs::read_to_string(&log_file).unwrap();
    assert!(regex::Regex::new(r"\[\d{4}-\d\d-\d\d \d\d:\d\d:\d\d\.\d{3}\] Welcome").unwrap().is_match(&log), "{log}");
    assert!(events.lock().iter().any(|(ch, a)| ch == "conn:state" && a[1]["state"] == "connected"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(std::fs::metadata(&log_file).unwrap().permissions().mode() & 0o777, 0o600);
    }
}

#[tokio::test]
async fn only_a_working_password_is_saved_then_no_prompts() {
    let server = start(tmp("root")).await;
    let store = store();
    let passwords = Arc::new(Mutex::new(vec!["wrong", "secret"]));
    let p = passwords.clone();
    let (c, prompts) = ctx(&store, move |req| match req["kind"].as_str() {
        Some("hostkey") => json!("save"),
        Some("text") => {
            assert!(!truthy(&req["offerSave"]), "username prompt must not offer saving");
            json!("tester")
        }
        Some("password") => {
            assert_eq!(req["offerSave"], true, "password prompt offers saving");
            json!({ "value": p.lock().remove(0), "save": true })
        }
        _ => Value::Null,
    });
    // Ad-hoc quick-connect session: no username, password-only auth.
    let ad_hoc =
        json!({ "name": "quick", "protocol": "ssh2", "host": "127.0.0.1", "port": server.port, "auth": { "methods": ["password"], "useAgent": false } });
    let (ev, mut rx) = mpsc::unbounded_channel();
    let conn = connect_client(resolve(&store, &ad_hoc).unwrap(), c.clone(), ev, Mode::Tunnel).await.unwrap();
    let creds = loop {
        if let Some(Event::Credentials(c)) = rx.recv().await {
            break c;
        }
    };
    assert_eq!(creds, json!({ "username": "tester", "password": "secret" }), "username saved together with the password");
    assert_eq!(*prompts.lock(), vec!["text", "hostkey", "password", "password"]);
    conn.close();

    let session = store.lock().save_credentials(&ad_hoc, &creds).unwrap();
    assert_eq!(session["username"], "tester");
    assert_eq!(session["auth"]["hasPassword"], true);
    assert!(!store.lock().tree().to_string().contains("secret"));
    assert!(!std::fs::read_to_string(&store.lock().sessions_file).unwrap().contains("\"secret\""));

    // Reconnect with the saved session: no username or password prompts at all.
    prompts.lock().clear();
    let (ev, mut rx) = mpsc::unbounded_channel();
    let again = connect_client(resolve(&store, &session["id"]).unwrap(), c, ev, Mode::Tunnel).await.unwrap();
    assert!(prompts.lock().is_empty());
    again.close();
    while let Ok(e) = rx.try_recv() {
        assert!(!matches!(e, Event::Credentials(_)));
    }

    // Keyboard-interactive (how macOS sshd asks for passwords) can be saved too.
    let kstore = store_with_session(server.port);
    let (kc, _) = ctx(&kstore.0, |req| if req["kind"] == "hostkey" { json!("once") } else { json!({ "answers": ["secret"], "save": true }) });
    let (ev, mut rx) = mpsc::unbounded_channel();
    let k = connect_client(resolve(&kstore.0, &kstore.1).unwrap(), kc, ev, Mode::Tunnel).await.unwrap();
    let kcreds = loop {
        if let Some(Event::Credentials(c)) = rx.recv().await {
            break c;
        }
    };
    kstore.0.lock().save_credentials(&kstore.1, &kcreds).unwrap();
    k.close();
    assert_eq!(kstore.0.lock().resolve_session(&kstore.1).unwrap()["auth"]["password"], "secret");
}

fn store_with_session(port: u16) -> (Arc<Mutex<Store>>, Value) {
    let s = store();
    let saved = s.lock().save_session(&json!({ "name": "k", "protocol": "ssh2", "host": "127.0.0.1", "port": port, "username": "tester", "auth": { "methods": ["keyboard-interactive"], "useAgent": false } })).unwrap();
    (s, saved["id"].clone())
}

#[tokio::test]
async fn nothing_saved_unless_the_box_is_ticked_and_bad_logins_fail() {
    let server = start(tmp("root")).await;
    let store = store();
    let (c, _) = ctx(&store, |req| match req["kind"].as_str() {
        Some("hostkey") => json!("once"),
        Some("text") => json!("tester"),
        _ => json!({ "value": "secret", "save": false }),
    });
    let (ev, mut rx) = mpsc::unbounded_channel();
    let conn = connect_client(
        resolve(&store, &json!({ "protocol": "ssh2", "host": "127.0.0.1", "port": server.port, "auth": { "methods": ["password"], "useAgent": false } }))
            .unwrap(),
        c,
        ev,
        Mode::Tunnel,
    )
    .await
    .unwrap();
    conn.close();
    while let Ok(e) = rx.try_recv() {
        assert!(!matches!(e, Event::Credentials(_)));
    }
    // A rejected host key and a cancelled password both fail cleanly.
    let (c, _) = ctx(&store, |_| Value::Null);
    let (ev, _rx) = mpsc::unbounded_channel();
    let e = connect_client(resolve(&store, &json!({ "protocol": "ssh2", "host": "127.0.0.1", "port": server.port, "username": "tester", "auth": { "methods": ["password"], "useAgent": false } })).unwrap(), c, ev, Mode::Tunnel).await.err().unwrap();
    assert!(e.to_string().contains("Host key"), "{e}");
}

fn exec_of(c: Arc<SshClient>) -> Exec {
    Arc::new(move |cmd: String| {
        let c = c.clone();
        Box::pin(async move { c.exec(&cmd).await })
    })
}

#[cfg(unix)]
#[tokio::test]
async fn scp_over_ssh_direct() {
    let remote = tmp("scpremote");
    let server = start(remote.clone()).await;
    let store = store();
    let (c, _) = ctx(&store, |req| if req["kind"] == "hostkey" { json!("once") } else { Value::Null });
    let (ev, _rx) = mpsc::unbounded_channel();
    let conn = connect_client(resolve(&store, &json!({ "protocol": "ssh2", "host": "127.0.0.1", "port": server.port, "username": "u", "auth": { "password": "secret", "methods": ["password"], "useAgent": false } })).unwrap(), c, ev, Mode::Tunnel).await.unwrap();
    crate::scp::tests::exercise(&exec_of(conn.clone()), &remote).await;
    assert_eq!(server.stats.tunnels.load(std::sync::atomic::Ordering::SeqCst), 0, "direct: no jump tunnel used");
    conn.close();
}

#[cfg(unix)]
#[tokio::test]
async fn scp_through_a_jump_host_saved_and_ad_hoc() {
    let remote = tmp("scpremote");
    let target = start(remote.clone()).await;
    let jump = start(tmp("jumproot")).await;
    let store = store();
    let auth = json!({ "password": "secret", "methods": ["password"], "useAgent": false });
    let jump_saved = store
        .lock()
        .save_session(&json!({ "name": "bastion", "protocol": "ssh2", "host": "127.0.0.1", "port": jump.port, "username": "j", "auth": auth }))
        .unwrap();
    let local = crate::scp::tests::make_local_tree();
    let (c, _) = ctx(&store, |req| if req["kind"] == "hostkey" { json!("once") } else { Value::Null });
    let none = |_: Value| {};

    // Saved jump session.
    let (ev, _rx) = mpsc::unbounded_channel();
    let via_saved = connect_client(resolve(&store, &json!({ "protocol": "ssh2", "host": "127.0.0.1", "port": target.port, "username": "u", "auth": auth, "ssh": { "jumpSessionId": jump_saved["id"] } })).unwrap(),
        c.clone(),
        ev,
        Mode::Tunnel,
    )
    .await
    .unwrap();
    crate::scp::upload(&exec_of(via_saved.clone()), &[local.join("hello.txt")], ".", true, Default::default(), &none).await.unwrap();
    via_saved.close();
    assert_eq!(std::fs::read_to_string(remote.join("hello.txt")).unwrap(), "hello scp\n");
    assert_eq!(jump.stats.tunnels.load(std::sync::atomic::Ordering::SeqCst), 1, "went through the jump host");

    // Ad-hoc jump host (typed as user@host:port, not saved).
    let (ev, _rx) = mpsc::unbounded_channel();
    let via_adhoc = connect_client(
        resolve(
            &store,
            &json!({ "protocol": "ssh2", "host": "127.0.0.1", "port": target.port, "username": "u", "auth": auth,
                "ssh": { "jumpSession": { "protocol": "ssh2", "host": "127.0.0.1", "port": jump.port, "username": "j", "auth": auth } } }),
        )
        .unwrap(),
        c,
        ev,
        Mode::Tunnel,
    )
    .await
    .unwrap();
    let back = tmp("back");
    crate::scp::download(&exec_of(via_adhoc.clone()), "hello.txt", &back, true, Default::default(), &none).await.unwrap();
    via_adhoc.close();
    assert_eq!(std::fs::read_to_string(back.join("hello.txt")).unwrap(), "hello scp\n");
    assert_eq!(jump.stats.tunnels.load(std::sync::atomic::Ordering::SeqCst), 2);
    assert_eq!(target.stats.execs.lock().len(), 2, "scp commands ran on the target, not the jump host");
    assert_eq!(jump.stats.execs.lock().len(), 0);
}

#[tokio::test]
async fn a_session_cannot_be_its_own_jump_host() {
    let store = store();
    let s = store.lock().save_session(&json!({ "name": "loop", "protocol": "ssh2", "host": "127.0.0.1", "port": 1 })).unwrap();
    let id = s["id"].clone();
    let mut fixed = s.clone();
    fixed["ssh"] = json!({ "jumpSessionId": id });
    store.lock().save_session(&fixed).unwrap();
    let (c, _) = ctx(&store, |_| Value::Null);
    let (ev, _rx) = mpsc::unbounded_channel();
    let e = connect_client(resolve(&store, &id).unwrap(), c, ev, Mode::Tunnel).await.err().unwrap();
    assert!(e.to_string().contains("itself"), "{e}");
}

async fn fake_vnc() -> u16 {
    let l = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let port = l.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut s, _)) = l.accept().await {
            tokio::spawn(async move {
                s.write_all(b"RFB 003.008\n").await.unwrap();
                let mut buf = [0u8; 64];
                if let Ok(n) = s.read(&mut buf).await {
                    let _ = s.write_all(&buf[..n]).await;
                }
            });
        }
    });
    port
}

/// Connect to a VNC bridge URL, read the server hello, send "ping" and read the echo.
async fn ws_round_trip(url: &str) -> Result<Vec<String>, String> {
    use futures::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;
    let (mut ws, _) = tokio_tungstenite::connect_async(url).await.map_err(|e| e.to_string())?;
    let mut got = Vec::new();
    match ws.next().await {
        Some(Ok(Message::Binary(b))) => got.push(String::from_utf8_lossy(&b).into_owned()),
        Some(Ok(Message::Close(f))) => return Err(format!("closed {}", f.map(|f| u16::from(f.code)).unwrap_or(0))),
        other => return Err(format!("{other:?}")),
    }
    ws.send(Message::Binary(b"ping".to_vec().into())).await.map_err(|e| e.to_string())?;
    if let Some(Ok(Message::Binary(b))) = ws.next().await {
        got.push(String::from_utf8_lossy(&b).into_owned());
    }
    Ok(got)
}

#[tokio::test]
async fn vnc_bridge_direct_and_through_an_ssh_tunnel() {
    let vnc = fake_vnc().await;
    let tunnel = start(tmp("root")).await;
    let store = store();
    let (bus, _) = Bus::fake(|_, req| if req["kind"] == "hostkey" { json!("once") } else { Value::Null });
    let bridge = crate::remote_desktop::VncBridge::new(bus, store.clone());
    let direct =
        store.lock().save_session(&json!({ "name": "mac", "protocol": "vnc", "host": "127.0.0.1", "port": vnc, "auth": { "password": "vncpw" } })).unwrap();
    let info = bridge.open("tab1", &direct["id"]).await.unwrap();
    let url = info["url"].as_str().unwrap().to_string();
    assert!(regex::Regex::new(r"^ws://127\.0\.0\.1:\d+/vnc/[0-9a-f]{48}$").unwrap().is_match(&url));
    assert_eq!(info["password"], "vncpw");
    assert_eq!(ws_round_trip(&url).await.unwrap(), vec!["RFB 003.008\n", "ping"]);
    let bad = format!("{}{}", &url[..url.len() - 48], "f".repeat(48));
    assert!(ws_round_trip(&bad).await.unwrap_err().contains("1008"));

    let ssh = store.lock().save_session(&json!({ "name": "bastion", "protocol": "ssh2", "host": "127.0.0.1", "port": tunnel.port, "username": "u", "auth": { "password": "secret", "methods": ["password"], "useAgent": false } })).unwrap();
    let via = store
        .lock()
        .save_session(&json!({ "name": "mac via bastion", "protocol": "vnc", "host": "127.0.0.1", "port": vnc, "tunnel": { "sshSessionId": ssh["id"] } }))
        .unwrap();
    let info2 = bridge.open("tab2", &via["id"]).await.unwrap();
    assert_eq!(info2["via"], "bastion");
    assert_eq!(ws_round_trip(info2["url"].as_str().unwrap()).await.unwrap(), vec!["RFB 003.008\n", "ping"]);
    assert_eq!(tunnel.stats.tunnels.load(std::sync::atomic::Ordering::SeqCst), 1);

    // Closing a tab revokes its URL.
    bridge.close("tab1");
    assert!(ws_round_trip(&url).await.unwrap_err().contains("1008"));
    bridge.close_all();
}

#[cfg(unix)]
#[tokio::test]
async fn rdp_ssh_tunnel_carries_the_client_connection() {
    let target = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let tport = target.local_addr().unwrap().port();
    tokio::spawn(async move {
        while let Ok((mut c, _)) = target.accept().await {
            tokio::spawn(async move {
                let mut buf = [0u8; 64];
                let n = c.read(&mut buf).await.unwrap_or(0);
                let _ = c.write_all(format!("rdp:{}", String::from_utf8_lossy(&buf[..n])).as_bytes()).await;
            });
        }
    });
    let tunnel = start(tmp("root")).await;
    let dir = tmp("rdp");
    let store = Arc::new(Mutex::new(Store::new(&dir.join("data"), None).unwrap()));
    let marker = dir.join("launched.txt");
    store.lock().save_settings(&json!({ "rdpClient": format!("/bin/sh -c \"echo $0 $1 $2 > '{}'\" {{host}} {{port}} {{user}}", marker.display()) })).unwrap();
    let ssh = store.lock().save_session(&json!({ "name": "bastion", "protocol": "ssh2", "host": "127.0.0.1", "port": tunnel.port, "username": "u", "auth": { "password": "secret", "methods": ["password"], "useAgent": false } })).unwrap();
    let sess = store
        .lock()
        .save_session(
            &json!({ "name": "win", "protocol": "rdp", "host": "127.0.0.1", "port": tport, "username": "alice", "tunnel": { "sshSessionId": ssh["id"] } }),
        )
        .unwrap();
    let (bus, _) = Bus::fake(|_, req| if req["kind"] == "hostkey" { json!("once") } else { Value::Null });
    let rdp = crate::remote_desktop::RdpService::new(bus, store);
    let info = rdp.launch("tab1", &sess["id"]).await.unwrap();
    assert_eq!(info["via"], "bastion");
    let local = info["localPort"].as_u64().unwrap();
    for _ in 0..100 {
        if marker.exists() && !std::fs::read_to_string(&marker).unwrap().is_empty() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
    assert_eq!(std::fs::read_to_string(&marker).unwrap().trim(), format!("127.0.0.1 {local} alice"));
    let mut c = tokio::net::TcpStream::connect(("127.0.0.1", local as u16)).await.unwrap();
    c.write_all(b"hello").await.unwrap();
    let mut reply = String::new();
    let _ = tokio::time::timeout(Duration::from_secs(5), c.read_to_string(&mut reply)).await;
    assert_eq!(reply, "rdp:hello");
    assert_eq!(tunnel.stats.tunnels.load(std::sync::atomic::Ordering::SeqCst), 1);
    rdp.close_all();
}

/// Closing a tab while its output is still arriving must not crash (every protocol).
#[cfg(unix)]
#[tokio::test]
async fn closing_a_tab_with_output_in_flight() {
    // The connection's event task runs in the background, so catch its panics with a hook.
    static PANICKED: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        if info.to_string().contains("decoder") {
            PANICKED.store(true, std::sync::atomic::Ordering::SeqCst);
        }
        prev(info);
    }));
    let store = store();
    let (bus, _) = Bus::fake(|_, _| Value::Null);
    let mgr = Manager::new(bus, store);
    for i in 0..20 {
        let tab = format!("t{i}");
        mgr.open(&tab, &json!({ "protocol": "local", "local": { "shell": "/bin/sh", "args": "-c \"yes output | head -c 2000000\"" } }), 80, 24).await.unwrap();
        tokio::time::sleep(Duration::from_millis(5)).await;
        mgr.close(&tab, i % 2 == 0);
    }
    tokio::time::sleep(Duration::from_millis(500)).await;
    assert!(!PANICKED.load(std::sync::atomic::Ordering::SeqCst), "a closed tab's late output crashed the connection task");
}
