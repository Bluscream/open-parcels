import type { Clock } from "../../src/clock.js";
import type { RegisteredPlugin } from "../../src/engine/registry.js";
import type { PluginSourceKind } from "../../src/plugin/api.js";
import { HostLimiter, PluginHttp } from "../../src/plugin/http.js";

/** A pasted-link sign-in never touches the network in its first step. */
function noNetwork(clock: Clock): PluginHttp {
  return new PluginHttp(
    { limits: {} },
    new HostLimiter(clock, () => Promise.resolve()),
    clock,
    () =>
      Promise.reject(
        new Error("The first step of a pasted-link sign-in must not use the network."),
      ),
  );
}

export interface PastedDriver {
  start(config: unknown, clock: Clock): Promise<Started>;
  finish(http: PluginHttp, clock: Clock, state: Started["state"], text: string): Promise<unknown>;
}

interface Started {
  readonly url: string;
  readonly state: {
    readonly config: unknown;
    readonly kind: PluginSourceKind;
    readonly flow: string;
    readonly inner: unknown;
  };
}

function pick(plugin: RegisteredPlugin, config: unknown): { kind: PluginSourceKind; flow: string } {
  for (const kind of plugin.info.sourceKinds) {
    const flow = plugin.signInFlows(kind, config).find((each) => each.type === "interactive");
    if (flow !== undefined) {
      return { kind, flow: flow.id };
    }
  }
  throw new Error(`${plugin.info.id} has no interactive sign-in for this configuration.`);
}

/** Drives a plug-in's pasted-link flow in two calls, as the compatibility routes do. */
export function pasted(plugin: RegisteredPlugin): PastedDriver {
  return {
    async start(config: unknown, clock: Clock): Promise<Started> {
      const { kind, flow } = pick(plugin, config);
      const turn = await plugin.signInTurn({
        action: "start",
        flowId: flow,
        kind,
        rawConfig: config,
        http: noNetwork(clock),
        clock,
      });
      if (!("step" in turn) || turn.step.kind !== "open_url") {
        throw new Error("Not a pasted-link flow.");
      }
      return { url: turn.step.url, state: { config, kind, flow, inner: turn.state } };
    },
    async finish(
      http: PluginHttp,
      clock: Clock,
      state: Started["state"],
      text: string,
    ): Promise<unknown> {
      const turn = await plugin.signInTurn({
        action: "continue",
        flowId: state.flow,
        kind: state.kind,
        rawConfig: state.config,
        http,
        clock,
        state: state.inner,
        input: { pasted: text },
      });
      if (!("secret" in turn)) {
        throw new Error("The pasted-link flow asked for another step.");
      }
      return turn.secret;
    },
  };
}
