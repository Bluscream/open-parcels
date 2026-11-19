import "@testing-library/jest-dom/vitest";
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

// jsdom has no layout; the router restores scroll positions on navigation.
window.scrollTo = (): void => undefined;

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
