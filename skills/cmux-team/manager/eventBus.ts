import { EventEmitter } from "events";
import { log } from "./logger";

const bus = new EventEmitter();

const TRACE = !!process.env.CMUX_TEAM_TRACE_EVENTS;

export function notifyStateChanged(source: string): void {
  bus.emit("state-changed");
  if (TRACE) {
    log("event_emit", `event=state-changed source=${source}`).catch(() => {});
  }
}

export function onStateChanged(cb: () => void): () => void {
  bus.on("state-changed", cb);
  return () => {
    bus.off("state-changed", cb);
  };
}

export function __resetBusForTest(): void {
  bus.removeAllListeners();
}

export function __listenerCountForTest(): number {
  return bus.listenerCount("state-changed");
}
