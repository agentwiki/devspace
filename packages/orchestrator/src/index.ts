/**
 * @devspace/orchestrator
 *
 * The control plane and the ONLY component that knows all others. Owns the
 * work-unit FSM and routes events so the provider dependency graph stays a DAG:
 *   orchestrator -> chat-gateway (render), agent-runner (turn), sandbox-core (env)
 *   providers -> orchestrator (events, up)
 *   agent-runner -> sandbox-core (exec, the one allowed downward cross-edge)
 */
import type { ChatEvent, RenderCommand } from '@devspace/contracts';
import type { Repositories } from '@devspace/db';
import type { SandboxCore } from '@devspace/sandbox-core';
import type { AgentRunner } from '@devspace/agent-runner';
import { classifyAction, WorkUnitMachine } from './stateMachine.js';

export * from './stateMachine.js';

export interface OrchestratorDeps {
  repos: Repositories;
  sandbox: SandboxCore;
  agents: AgentRunner;
  /** Push a render command to whichever platform owns the conversation. */
  render: (command: RenderCommand) => Promise<void>;
}

/**
 * M0 skeleton: shows the seams and the cycle-breaking routing. Real handlers
 * (provision env on repoChoice, run turn on message, classify buttons) land in M3/M4.
 */
export class Orchestrator {
  readonly machine: WorkUnitMachine;

  constructor(private readonly deps: OrchestratorDeps) {
    this.machine = new WorkUnitMachine(deps.repos.workUnits);
  }

  async handleChatEvent(event: ChatEvent): Promise<void> {
    switch (event.type) {
      case 'conversation.created':
        // M3: create conversation + work unit; if repo, provision env via sandbox.
        return;
      case 'message.posted':
        // M3/M4: ensure agent session; run a turn; stream normalized events to chat.
        return;
      case 'action.invoked': {
        const action = classifyAction(event.actionId);
        // deterministic vs agent vs approval — decided HERE, not by the providers.
        void action;
        void this.deps;
        return;
      }
    }
  }
}
