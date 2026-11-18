import type { SignInTurn } from "../../src/plugin/api.js";
import type { PluginSourceKind, SignInInput, SignInStep } from "../../src/plugin/api.js";
import type { World } from "./harness.js";

/**
 * Walks one interactive sign-in flow of a carrier on the harness, holding the state between
 * steps the way the server does. Each call returns the step it reached; `secret` is set when done.
 */
export class SignInDriver {
  state: unknown = undefined;
  step: SignInStep | null = null;
  secret: unknown = undefined;

  constructor(
    private readonly world: Pick<World, "plugin" | "base" | "clock">,
    private readonly flowId: string,
    private readonly kind: PluginSourceKind,
    private readonly config: unknown = {},
  ) {}

  start(): Promise<SignInStep | null> {
    return this.#run("start");
  }

  continue(input: SignInInput): Promise<SignInStep | null> {
    return this.#run("continue", input);
  }

  poll(): Promise<SignInStep | null> {
    return this.#run("poll");
  }

  async #run(
    action: "start" | "continue" | "poll",
    input?: SignInInput,
  ): Promise<SignInStep | null> {
    const turn: SignInTurn<unknown> = await this.world.plugin.signInTurn({
      action,
      flowId: this.flowId,
      kind: this.kind,
      rawConfig: this.config,
      http: this.world.base().http,
      clock: this.world.clock,
      ...(action === "start" ? {} : { state: this.state }),
      ...(input === undefined ? {} : { input }),
    });
    if ("secret" in turn) {
      this.secret = turn.secret;
      this.step = null;
      return null;
    }
    this.state = turn.state;
    this.step = turn.step;
    return turn.step;
  }
}
