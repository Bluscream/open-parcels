import type { Logger } from "pino";
import { MIN_ADMIN_PASSWORD, type AppConfig } from "../config.js";
import type { ConfigSettings } from "../settings/config-settings.js";
import { humanCode, safeEqual } from "./crypto.js";
import type { AuthStore, Role } from "./store.js";

const ADMIN_KEY = "OPENPARCELS_ADMIN_PASSWORD";

export type AccessResult = { readonly ok: true } | { readonly ok: false; readonly error: string };

/**
 * The two passwords. The admin password may change anything; the reader password
 * (OPENPARCELS_PASSWORD) may only read, and when it is empty reading needs no sign-in at all.
 *
 * The admin password comes from the environment, or from the Settings page, where it is saved
 * scrypt-hashed in the `owner` row and wins until reset. With neither, a one-time setup code
 * printed to the log is needed to choose one, so writes are never open to everyone.
 */
export class AccessControl {
  /** Whether an admin password is saved here (cached; only this class changes it). */
  #saved: boolean;
  #setupCode: string | undefined;

  private constructor(
    private readonly store: AuthStore,
    private readonly config: AppConfig,
    private readonly settings: ConfigSettings,
    private readonly logger: Logger,
    saved: boolean,
  ) {
    this.#saved = saved;
    this.#setupCode = this.#adminConfigured() ? undefined : humanCode();
    settings.markSavedElsewhere(ADMIN_KEY, saved);
  }

  static async create(
    store: AuthStore,
    config: AppConfig,
    settings: ConfigSettings,
    logger: Logger,
  ): Promise<AccessControl> {
    return new AccessControl(store, config, settings, logger, await store.hasOwner());
  }

  /** Reading needs a sign-in (reader or admin). */
  get readerRequired(): boolean {
    return this.config.readerPassword !== "";
  }

  /** First start: no admin password anywhere yet. */
  get setupPending(): boolean {
    return this.#setupCode !== undefined;
  }

  /** The code to print to the log while setup is pending. */
  get setupCode(): string | undefined {
    return this.#setupCode;
  }

  setupCodeMatches(candidate: string): boolean {
    const normalise = (value: string): string => value.toUpperCase().replace(/[^A-Z]/g, "");
    return this.#setupCode !== undefined && normalise(candidate) === normalise(this.#setupCode);
  }

  /** The role a password signs in as; admin wins when both passwords are the same. */
  async roleFor(password: string): Promise<Role | null> {
    if (await this.#isAdminPassword(password)) return "admin";
    if (this.readerRequired && safeEqual(password, this.config.readerPassword)) return "reader";
    return null;
  }

  /** First start: chooses the admin password, saved hashed. */
  async completeSetup(password: string): Promise<void> {
    await this.store.setOwnerPassword(password);
    this.#setSaved(true);
    this.#setupCode = undefined;
  }

  /**
   * Replaces the admin password with one saved here (hashed). Signs every session out, the
   * caller's included. `current` may be null only when Home Assistant ingress vouches.
   */
  async changeAdminPassword(current: string | null, next: string): Promise<AccessResult> {
    if (current !== null && !(await this.#isAdminPassword(current))) {
      return { ok: false, error: "The current admin password is wrong." };
    }
    if (next.length < MIN_ADMIN_PASSWORD) {
      return { ok: false, error: `Use at least ${MIN_ADMIN_PASSWORD} characters.` };
    }
    await this.store.setOwnerPassword(next);
    this.#setSaved(true);
    this.#setupCode = undefined;
    await this.store.deleteAllSessions();
    this.logger.info("Admin password changed in the UI; every session was signed out.");
    return { ok: true };
  }

  /** Forgets the saved admin password so the environment's applies; signs everyone out. */
  async resetAdminPassword(): Promise<AccessResult> {
    if (this.config.adminPassword === undefined) {
      return {
        ok: false,
        error:
          "There is no OPENPARCELS_ADMIN_PASSWORD in the environment to fall back to; change the password instead.",
      };
    }
    if (!this.#saved) return { ok: true };
    await this.store.clearOwnerPassword();
    this.#setSaved(false);
    await this.store.deleteAllSessions();
    this.logger.info("Admin password reset to the environment's; every session was signed out.");
    return { ok: true };
  }

  /** After the reader password changed: readers sign in again with the new one. */
  async readerPasswordChanged(): Promise<void> {
    await this.store.deleteSessionsWithRole("reader");
  }

  #adminConfigured(): boolean {
    return this.#saved || this.config.adminPassword !== undefined;
  }

  async #isAdminPassword(password: string): Promise<boolean> {
    if (this.#saved) return this.store.verifyOwnerPassword(password);
    const fromEnv = this.config.adminPassword;
    return fromEnv !== undefined && safeEqual(password, fromEnv);
  }

  #setSaved(saved: boolean): void {
    this.#saved = saved;
    this.settings.markSavedElsewhere(ADMIN_KEY, saved);
  }
}
