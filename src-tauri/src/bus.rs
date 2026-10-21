// SPDX-License-Identifier: GPL-2.0-or-later
// Copyright (C) 2026 Gabriel Moreno and contributors
//! The link from the backend to the window: events for the page, and questions for the user
//! (prompts, dialogs drawn by the page) that the page answers.

use futures::future::BoxFuture;
use serde_json::Value;
use std::sync::Arc;

pub type SendFn = Arc<dyn Fn(&str, Vec<Value>) + Send + Sync>;
/// Events a test bus recorded: (channel, args).
#[cfg(test)]
pub type Recorded = Arc<parking_lot::Mutex<Vec<(String, Vec<Value>)>>>;
pub type RequestFn = Arc<dyn Fn(&str, Value) -> BoxFuture<'static, Value> + Send + Sync>;

#[derive(Clone)]
pub struct Bus {
    send: SendFn,
    request: RequestFn,
}

impl Bus {
    pub fn new(send: SendFn, request: RequestFn) -> Bus {
        Bus { send, request }
    }

    /// Send an event to the page (`channel` with its arguments).
    pub fn send(&self, channel: &str, args: Vec<Value>) {
        (self.send)(channel, args)
    }

    /// Ask the page; resolves to its answer (null if the window is gone).
    pub fn request(&self, kind: &str, payload: Value) -> BoxFuture<'static, Value> {
        (self.request)(kind, payload)
    }

    /// A bus that records nothing and answers every request with `answer` (tests).
    #[cfg(test)]
    pub fn fake(answer: impl Fn(&str, &Value) -> Value + Send + Sync + 'static) -> (Bus, Recorded) {
        let events: Recorded = Default::default();
        let e = events.clone();
        let answer = Arc::new(answer);
        (
            Bus::new(
                Arc::new(move |ch, args| e.lock().push((ch.to_string(), args))),
                Arc::new(move |kind, payload| {
                    let v = answer(kind, &payload);
                    Box::pin(async move { v })
                }),
            ),
            events,
        )
    }
}
