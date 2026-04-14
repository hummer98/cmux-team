import { describe, test, expect, beforeEach } from "bun:test";
import {
  notifyStateChanged,
  onStateChanged,
  __resetBusForTest,
  __listenerCountForTest,
} from "./eventBus";

describe("eventBus", () => {
  beforeEach(() => {
    __resetBusForTest();
  });

  test("notifyStateChanged で登録 callback が呼ばれる", () => {
    let count = 0;
    onStateChanged(() => {
      count += 1;
    });
    notifyStateChanged("test:basic");
    expect(count).toBe(1);
    notifyStateChanged("test:basic-2");
    expect(count).toBe(2);
  });

  test("複数の listener が並行に呼ばれる", () => {
    let a = 0;
    let b = 0;
    onStateChanged(() => {
      a += 1;
    });
    onStateChanged(() => {
      b += 1;
    });
    notifyStateChanged("test:multi");
    expect(a).toBe(1);
    expect(b).toBe(1);
  });

  test("unsubscribe で off される", () => {
    let count = 0;
    const unsub = onStateChanged(() => {
      count += 1;
    });
    notifyStateChanged("test:before-unsub");
    expect(count).toBe(1);
    unsub();
    notifyStateChanged("test:after-unsub");
    expect(count).toBe(1);
    expect(__listenerCountForTest()).toBe(0);
  });

  test("__resetBusForTest で listener が全削除される", () => {
    onStateChanged(() => {});
    onStateChanged(() => {});
    expect(__listenerCountForTest()).toBe(2);
    __resetBusForTest();
    expect(__listenerCountForTest()).toBe(0);
  });
});
