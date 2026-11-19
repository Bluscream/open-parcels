import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom has no layout; the router restores scroll positions on navigation.
window.scrollTo = (): void => undefined;

// jsdom has no ResizeObserver; the resizable split panels need one.
class NoopResizeObserver {
  observe(): void {
    return undefined;
  }
  unobserve(): void {
    return undefined;
  }
  disconnect(): void {
    return undefined;
  }
}
if (!("ResizeObserver" in window)) {
  Object.assign(window, { ResizeObserver: NoopResizeObserver });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
