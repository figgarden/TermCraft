// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! "Launch Application" buttons. The command is split into a program and its arguments and run
//! without a shell, so characters like ; | & $( ) ` are passed to the program as plain text.
//! Each distinct command must be approved once in a native dialog; approvals live in a file only
//! the backend writes, so an imported button bar or a compromised page cannot skip it.

use crate::security::{build_argv, safe_json_parse};
use crate::store::write_private;
use anyhow::{Result, bail};
use futures::future::BoxFuture;
use std::collections::{BTreeSet, HashMap};
use std::path::PathBuf;

#[derive(Clone, Copy, PartialEq, Debug)]
pub enum Approval {
    Cancel,
    Once,
    Always,
}

pub type Confirm = Box<dyn Fn(Vec<String>, String) -> BoxFuture<'static, Approval> + Send + Sync>;
pub type Spawn = Box<dyn Fn(&str, &[String]) -> std::io::Result<()> + Send + Sync>;

/// Split a button command into argv; fails with a readable error if it can't be run.
pub fn launch_argv(command: &str) -> Result<Vec<String>> {
    if command.contains(['\0', '\r', '\n']) {
        bail!("The command contains a line break");
    }
    let argv = build_argv(command, &HashMap::new())?;
    if argv.is_empty() || argv[0].is_empty() {
        bail!("The command is empty");
    }
    Ok(argv)
}

/// Start a program detached from TermCraft, without a shell.
pub fn spawn_detached(program: &str, args: &[String]) -> std::io::Result<()> {
    let mut cmd = std::process::Command::new(program);
    cmd.args(args).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    cmd.spawn().map(|_| ())
}

pub struct Launcher {
    file: PathBuf,
    confirm: Confirm,
    spawn: Spawn,
    windows: bool,
    pub approved: BTreeSet<String>,
}

impl Launcher {
    pub fn new(file: PathBuf, confirm: Confirm, spawn: Option<Spawn>, windows: Option<bool>) -> Launcher {
        let list = std::fs::read_to_string(&file).ok().and_then(|t| safe_json_parse(&t).ok());
        let approved = list.and_then(|v| v.as_array().cloned()).unwrap_or_default().into_iter().filter_map(|c| c.as_str().map(String::from)).collect();
        Launcher { file, confirm, spawn: spawn.unwrap_or_else(|| Box::new(spawn_detached)), windows: windows.unwrap_or(cfg!(windows)), approved }
    }

    pub fn is_approved(&self, command: &str) -> bool {
        self.approved.contains(command)
    }

    fn approve(&mut self, command: &str) -> Result<()> {
        self.approved.insert(command.to_string());
        write_private(&self.file, &serde_json::to_string_pretty(&self.approved)?)
    }

    /// Ask for approval if needed. Returns the argv to run, or None if the user declined.
    pub async fn prepare(&self, command: &str) -> Result<(Vec<String>, Option<Approval>)> {
        let argv = launch_argv(command)?;
        if self.windows && regex::Regex::new(r"(?i)\.(bat|cmd)$").unwrap().is_match(&argv[0]) {
            bail!("Batch files can't be started directly. Use: cmd /c {command}");
        }
        if self.is_approved(command) {
            return Ok((argv, None));
        }
        Ok((argv.clone(), Some((self.confirm)(argv, command.to_string()).await)))
    }

    /// Record the user's answer and start the program; false if the user declined.
    pub fn finish(&mut self, command: &str, argv: &[String], answer: Option<Approval>) -> Result<bool> {
        match answer {
            Some(Approval::Cancel) => return Ok(false),
            Some(Approval::Always) => self.approve(command)?,
            _ => {}
        }
        (self.spawn)(&argv[0], &argv[1..]).map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                anyhow::anyhow!("Program not found: {}", argv[0])
            } else {
                anyhow::anyhow!("Could not start {}: {e}", argv[0])
            }
        })?;
        Ok(true)
    }

    /// Run a command; false if the user declined, an error if the program can't start.
    pub async fn run(&mut self, command: &str) -> Result<bool> {
        let (argv, answer) = self.prepare(command).await?;
        self.finish(command, &argv, answer)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, Mutex};

    type Calls = Arc<Mutex<Vec<(String, Vec<String>)>>>;

    fn fake_spawn(calls: Calls, fail: bool) -> Spawn {
        Box::new(move |cmd, args| {
            calls.lock().unwrap().push((cmd.to_string(), args.to_vec()));
            if fail { Err(std::io::Error::new(std::io::ErrorKind::NotFound, "ENOENT")) } else { Ok(()) }
        })
    }

    fn answer_with(a: Arc<Mutex<Approval>>, asked: Arc<Mutex<usize>>) -> Confirm {
        Box::new(move |_, _| {
            let a = *a.lock().unwrap();
            *asked.lock().unwrap() += 1;
            Box::pin(async move { a })
        })
    }

    fn tmp_file() -> PathBuf {
        crate::store::tests::tmp("launch").join("approved_commands.json")
    }

    #[tokio::test]
    async fn metacharacters_are_plain_arguments() {
        let calls: Calls = Default::default();
        let mut l = Launcher::new(
            tmp_file(),
            answer_with(Arc::new(Mutex::new(Approval::Once)), Default::default()),
            Some(fake_spawn(calls.clone(), false)),
            Some(false),
        );
        assert!(l.run("ping -c 1 host; touch /tmp/pwned && $(id) `id` | cat").await.unwrap());
        let c = calls.lock().unwrap();
        assert_eq!(c[0].0, "ping");
        assert_eq!(c[0].1, vec!["-c", "1", "host;", "touch", "/tmp/pwned", "&&", "$(id)", "`id`", "|", "cat"]);
        assert_eq!(launch_argv("open -a \"Visual Studio Code\"").unwrap(), vec!["open", "-a", "Visual Studio Code"]);
    }

    #[tokio::test]
    async fn approvals_once_always_cancel() {
        let file = tmp_file();
        let calls: Calls = Default::default();
        let asked: Arc<Mutex<usize>> = Default::default();
        let answer = Arc::new(Mutex::new(Approval::Cancel));
        let mut l = Launcher::new(file.clone(), answer_with(answer.clone(), asked.clone()), Some(fake_spawn(calls.clone(), false)), Some(false));
        assert!(!l.run("gedit").await.unwrap(), "cancel does not run");
        assert_eq!(calls.lock().unwrap().len(), 0);
        *answer.lock().unwrap() = Approval::Once;
        l.run("gedit").await.unwrap();
        l.run("gedit").await.unwrap();
        assert_eq!(*asked.lock().unwrap(), 3, "run once asks every time");
        *answer.lock().unwrap() = Approval::Always;
        l.run("gedit").await.unwrap();
        l.run("gedit").await.unwrap();
        assert_eq!(*asked.lock().unwrap(), 4, "always allow is remembered");
        assert_eq!(calls.lock().unwrap().len(), 4);
        assert_eq!(serde_json::from_str::<Vec<String>>(&std::fs::read_to_string(&file).unwrap()).unwrap(), vec!["gedit"]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600);
        }
        let mut l2 = Launcher::new(file, answer_with(Arc::new(Mutex::new(Approval::Once)), asked.clone()), Some(fake_spawn(calls.clone(), false)), Some(false));
        l2.run("gedit").await.unwrap();
        assert_eq!(*asked.lock().unwrap(), 4);
        l2.run("gedit; rm -rf ~").await.unwrap();
        assert_eq!(*asked.lock().unwrap(), 5);
    }

    #[tokio::test]
    async fn bad_commands_are_refused() {
        let mut l = Launcher::new(
            tmp_file(),
            answer_with(Arc::new(Mutex::new(Approval::Once)), Default::default()),
            Some(fake_spawn(Default::default(), true)),
            Some(false),
        );
        assert!(l.run("no-such-program").await.unwrap_err().to_string().contains("Program not found: no-such-program"));
        assert!(l.run("   ").await.unwrap_err().to_string().contains("empty"));
        assert!(l.run("a\nb").await.unwrap_err().to_string().contains("line break"));
        assert!(l.run("say \"unclosed").await.unwrap_err().to_string().contains("Unbalanced quote"));
        let mut w = Launcher::new(
            tmp_file(),
            answer_with(Arc::new(Mutex::new(Approval::Once)), Default::default()),
            Some(fake_spawn(Default::default(), false)),
            Some(true),
        );
        assert!(w.run("C:\\tools\\build.bat --x").await.unwrap_err().to_string().contains("cmd /c"));
    }

    #[test]
    fn tampered_approvals_file() {
        let file = tmp_file();
        std::fs::write(&file, r#"{"__proto__":{"x":1}}"#).unwrap();
        let l = Launcher::new(file, answer_with(Arc::new(Mutex::new(Approval::Cancel)), Default::default()), None, None);
        assert!(l.approved.is_empty());
    }
}
