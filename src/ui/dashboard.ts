import { renderHiveWordmark } from "./branding.js";
import { supportsColorOutput } from "./terminal.js";

export interface DashboardProps {
  providersApproved: number;
  rolesAssigned: string[];
  tasksCount: number;
  mode: string;
}

export function renderDashboard(props: DashboardProps, options?: { color?: boolean }): string {
  const useColor = options?.color ?? supportsColorOutput();
  const title = `♛ ${renderHiveWordmark("HIVE", { color: useColor })} · Hyper Intelligence for Verified Engineering`;
  
  const swarmDisplay = props.rolesAssigned.length > 0 ? props.rolesAssigned.join(" · ") : "None";

  return `
${title}

Queen: ready
Apiary: ${props.providersApproved} providers approved
Swarm: ${swarmDisplay}
Comb: ${props.tasksCount} task cells
Mode: ${props.mode}

Commands:
  run       Start a new coding flight
  status    Inspect current flight
  diff      Review current patch
  approve   Approve current patch
  providers Configure the apiary
  sessions  Manage task cells
`.trim();
}

export interface StatusProps {
  taskId: string;
  mode: string;
  branch: string;
  state: string;
  plannerState: string;
  builderState: string;
  validatorState: string;
  reviewerState: string;
  filesChanged: number;
  testsPassed: boolean;
  safety: string;
  nextCommands: string[];
}

export function renderStatus(props: StatusProps, options?: { color?: boolean }): string {
  const useColor = options?.color ?? supportsColorOutput();
  const title = `♛ ${renderHiveWordmark("HIVE", { color: useColor })} · Flight Status`;

  return `
${title}

Cell: ${props.taskId}
Mode: ${props.mode}
Branch: ${props.branch}
Queen: ${props.state}

Swarm:
  Planner    ${props.plannerState}
  Builder    ${props.builderState}
  Validator  ${props.validatorState}
  Reviewer   ${props.reviewerState}

Comb:
  Files changed: ${props.filesChanged}
  Tests: ${props.testsPassed ? "passed" : "failed"}
  Safety: ${props.safety}

Next:
${props.nextCommands.map(cmd => `  ${cmd}`).join("\n")}
`.trim();
}
