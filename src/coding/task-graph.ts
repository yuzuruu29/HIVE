import type { SubagentTask } from "./types.js";

export type TaskGraphIssueCode =
  | "duplicate_task_id"
  | "missing_dependency"
  | "cycle"
  | "duplicate_objective"
  | "missing_expected_output"
  | "missing_completion_criteria"
  | "missing_file_scope"
  | "invalid_file_scope"
  | "invalid_depth"
  | "task_limit_exceeded"
  | "depth_limit_exceeded"
  | "overlapping_file_scope";

export interface TaskGraphIssue {
  code: TaskGraphIssueCode;
  message: string;
  taskIds: string[];
}

export interface FileScopeConflict {
  taskIds: [string, string];
  scopes: string[];
}

export type FileScopeConflictPolicy = "reject" | "serialize" | "ignore";

export interface TaskGraphValidationOptions {
  maxTasks?: number;
  maxDepth?: number;
  conflictPolicy?: FileScopeConflictPolicy;
}

export interface TaskGraphValidationResult {
  valid: boolean;
  issues: TaskGraphIssue[];
  conflicts: FileScopeConflict[];
  topologicalOrder: string[];
}

export interface TaskSerializationEdge {
  taskId: string;
  dependsOn: string;
  scopes: string[];
}

export interface TaskGraphSerialization {
  tasks: SubagentTask[];
  conflicts: FileScopeConflict[];
  addedDependencies: TaskSerializationEdge[];
}

const DEFAULT_MAX_TASKS = 24;
const DEFAULT_MAX_DEPTH = 2;
const editingRoles = new Set<SubagentTask["role"]>(["builder", "fixer"]);

export class TaskGraphValidationError extends Error {
  public readonly result: TaskGraphValidationResult;

  public constructor(result: TaskGraphValidationResult) {
    super(
      `Invalid task graph: ${result.issues
        .map((issue) => issue.message)
        .join("; ")}`,
    );
    this.name = "TaskGraphValidationError";
    this.result = result;
  }
}

export function normalizeTaskObjective(objective: string): string {
  return objective
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

export function normalizeFileScope(scope: string): string {
  const normalized = scope
    .normalize("NFKC")
    .trim()
    .replace(/\\/gu, "/")
    .replace(/\/+/gu, "/");
  const segments: string[] = [];
  for (const segment of normalized.split("/")) {
    if (segment.length === 0 || segment === ".") {
      continue;
    }
    if (segment === "..") {
      if (segments.length > 0 && segments.at(-1) !== "..") {
        segments.pop();
      } else {
        segments.push(segment);
      }
      continue;
    }
    segments.push(segment);
  }
  return segments.join("/").toLocaleLowerCase("en-US");
}

function isUnsafeFileScope(rawScope: string, normalizedScope: string): boolean {
  const slashNormalized = rawScope.trim().replace(/\\/gu, "/");
  return (
    normalizedScope.length === 0 ||
    normalizedScope === ".." ||
    normalizedScope.startsWith("../") ||
    slashNormalized.startsWith("/") ||
    /^[a-zA-Z]:\//u.test(slashNormalized)
  );
}

function staticScopePrefix(scope: string): string {
  const wildcardIndex = scope.search(/[?*[]/u);
  if (wildcardIndex === -1) {
    return scope;
  }
  return scope.slice(0, wildcardIndex).replace(/\/+$/u, "");
}

function isBoundaryPrefix(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

export function fileScopesOverlap(left: string, right: string): boolean {
  const normalizedLeft = normalizeFileScope(left);
  const normalizedRight = normalizeFileScope(right);
  if (normalizedLeft.length === 0 || normalizedRight.length === 0) {
    return false;
  }
  if (normalizedLeft === normalizedRight) {
    return true;
  }

  const leftPrefix = staticScopePrefix(normalizedLeft);
  const rightPrefix = staticScopePrefix(normalizedRight);
  if (leftPrefix.length === 0 || rightPrefix.length === 0) {
    return true;
  }
  return (
    isBoundaryPrefix(leftPrefix, rightPrefix) ||
    isBoundaryPrefix(rightPrefix, leftPrefix)
  );
}

export function detectBuilderScopeConflicts(
  tasks: readonly SubagentTask[],
): FileScopeConflict[] {
  const builders = tasks.filter((task) => editingRoles.has(task.role));
  const conflicts: FileScopeConflict[] = [];

  for (let leftIndex = 0; leftIndex < builders.length; leftIndex += 1) {
    const left = builders[leftIndex];
    for (
      let rightIndex = leftIndex + 1;
      rightIndex < builders.length;
      rightIndex += 1
    ) {
      const right = builders[rightIndex];
      const overlappingScopes: string[] = [];
      for (const leftScope of left.fileScope) {
        for (const rightScope of right.fileScope) {
          if (!fileScopesOverlap(leftScope, rightScope)) {
            continue;
          }
          for (const scope of [leftScope, rightScope]) {
            const normalized = normalizeFileScope(scope);
            if (!overlappingScopes.includes(normalized)) {
              overlappingScopes.push(normalized);
            }
          }
        }
      }
      if (overlappingScopes.length > 0) {
        conflicts.push({
          taskIds: [left.id, right.id],
          scopes: overlappingScopes,
        });
      }
    }
  }
  return conflicts;
}

function findCycle(tasks: readonly SubagentTask[]): string[] {
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const stack: string[] = [];

  const visit = (taskId: string): string[] => {
    if (visiting.has(taskId)) {
      const start = stack.indexOf(taskId);
      return stack.slice(start);
    }
    if (visited.has(taskId)) {
      return [];
    }
    visiting.add(taskId);
    stack.push(taskId);
    const task = byId.get(taskId);
    if (task) {
      for (const dependency of task.dependencies) {
        if (!byId.has(dependency)) {
          continue;
        }
        const cycle = visit(dependency);
        if (cycle.length > 0) {
          return cycle;
        }
      }
    }
    stack.pop();
    visiting.delete(taskId);
    visited.add(taskId);
    return [];
  };

  for (const task of tasks) {
    const cycle = visit(task.id);
    if (cycle.length > 0) {
      return cycle;
    }
  }
  return [];
}

function topologicalOrder(tasks: readonly SubagentTask[]): string[] {
  const taskOrder = new Map(tasks.map((task, index) => [task.id, index]));
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>();
  for (const task of tasks) {
    indegree.set(task.id, task.dependencies.length);
    for (const dependency of task.dependencies) {
      const list = dependents.get(dependency) ?? [];
      list.push(task.id);
      dependents.set(dependency, list);
    }
  }

  const ready = tasks
    .filter((task) => (indegree.get(task.id) ?? 0) === 0)
    .map((task) => task.id);
  const result: string[] = [];
  while (ready.length > 0) {
    ready.sort(
      (left, right) =>
        (taskOrder.get(left) ?? 0) - (taskOrder.get(right) ?? 0),
    );
    const taskId = ready.shift();
    if (taskId === undefined) {
      break;
    }
    result.push(taskId);
    for (const dependent of dependents.get(taskId) ?? []) {
      const remaining = (indegree.get(dependent) ?? 0) - 1;
      indegree.set(dependent, remaining);
      if (remaining === 0) {
        ready.push(dependent);
      }
    }
  }
  return result;
}

function addIssue(
  issues: TaskGraphIssue[],
  code: TaskGraphIssueCode,
  message: string,
  taskIds: string[],
): void {
  issues.push({ code, message, taskIds });
}

function validateLimits(maxTasks: number, maxDepth: number): void {
  if (!Number.isInteger(maxTasks) || maxTasks < 1) {
    throw new RangeError("maxTasks must be a positive integer");
  }
  if (!Number.isInteger(maxDepth) || maxDepth < 0) {
    throw new RangeError("maxDepth must be a non-negative integer");
  }
}

export function validateTaskGraph(
  tasks: readonly SubagentTask[],
  options: TaskGraphValidationOptions = {},
): TaskGraphValidationResult {
  const maxTasks = options.maxTasks ?? DEFAULT_MAX_TASKS;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const conflictPolicy = options.conflictPolicy ?? "reject";
  validateLimits(maxTasks, maxDepth);

  const issues: TaskGraphIssue[] = [];
  if (tasks.length > maxTasks) {
    addIssue(
      issues,
      "task_limit_exceeded",
      `Task graph has ${tasks.length} tasks; limit is ${maxTasks}`,
      tasks.map((task) => task.id),
    );
  }

  const byId = new Map<string, SubagentTask>();
  const objectives = new Map<string, string>();
  for (const task of tasks) {
    const duplicateId = byId.get(task.id);
    if (duplicateId) {
      addIssue(
        issues,
        "duplicate_task_id",
        `Duplicate task ID: ${task.id}`,
        [duplicateId.id, task.id],
      );
    } else {
      byId.set(task.id, task);
    }

    const objective = normalizeTaskObjective(task.objective);
    const duplicateObjectiveId = objectives.get(objective);
    if (objective.length > 0 && duplicateObjectiveId !== undefined) {
      addIssue(
        issues,
        "duplicate_objective",
        `Tasks ${duplicateObjectiveId} and ${task.id} have duplicate objectives`,
        [duplicateObjectiveId, task.id],
      );
    } else if (objective.length > 0) {
      objectives.set(objective, task.id);
    }

    if (task.expectedOutput.trim().length === 0) {
      addIssue(
        issues,
        "missing_expected_output",
        `Task ${task.id} has no expected output`,
        [task.id],
      );
    }
    if (
      task.completionCriteria.length === 0 ||
      task.completionCriteria.some((criterion) => criterion.trim().length === 0)
    ) {
      addIssue(
        issues,
        "missing_completion_criteria",
        `Task ${task.id} has no complete completion criteria`,
        [task.id],
      );
    }
    if (editingRoles.has(task.role) && task.fileScope.length === 0) {
      addIssue(
        issues,
        "missing_file_scope",
        `Task ${task.id} has no file scope`,
        [task.id],
      );
    }
    if (
      task.fileScope.some((scope) =>
        isUnsafeFileScope(scope, normalizeFileScope(scope)),
      )
    ) {
      addIssue(
        issues,
        "invalid_file_scope",
        `Task ${task.id} has a file scope outside the repository`,
        [task.id],
      );
    }
    if (!Number.isInteger(task.depth) || task.depth < 0) {
      addIssue(
        issues,
        "invalid_depth",
        `Task ${task.id} has invalid depth ${task.depth}`,
        [task.id],
      );
    } else if (task.depth > maxDepth) {
      addIssue(
        issues,
        "depth_limit_exceeded",
        `Task ${task.id} depth ${task.depth} exceeds limit ${maxDepth}`,
        [task.id],
      );
    }
  }

  for (const task of tasks) {
    for (const dependency of task.dependencies) {
      if (!byId.has(dependency)) {
        addIssue(
          issues,
          "missing_dependency",
          `Task ${task.id} depends on missing task ${dependency}`,
          [task.id, dependency],
        );
      }
    }
  }

  const cycle = findCycle(tasks);
  if (cycle.length > 0) {
    addIssue(
      issues,
      "cycle",
      `Task graph contains a cycle: ${cycle.join(" -> ")}`,
      cycle,
    );
  }

  const conflicts = detectBuilderScopeConflicts(tasks);
  if (conflictPolicy === "reject") {
    for (const conflict of conflicts) {
      addIssue(
        issues,
        "overlapping_file_scope",
        `Tasks ${conflict.taskIds.join(" and ")} have overlapping file scopes`,
        [...conflict.taskIds],
      );
    }
  }

  const order =
    cycle.length === 0 &&
    !issues.some(
      (issue) =>
        issue.code === "duplicate_task_id" ||
        issue.code === "missing_dependency",
    )
      ? topologicalOrder(tasks)
      : [];

  return {
    valid: issues.length === 0,
    issues,
    conflicts,
    topologicalOrder: order,
  };
}

export function assertValidTaskGraph(
  tasks: readonly SubagentTask[],
  options: TaskGraphValidationOptions = {},
): TaskGraphValidationResult {
  const result = validateTaskGraph(tasks, options);
  if (!result.valid) {
    throw new TaskGraphValidationError(result);
  }
  return result;
}

function dependsOn(
  taskId: string,
  dependencyId: string,
  byId: ReadonlyMap<string, SubagentTask>,
  visited = new Set<string>(),
): boolean {
  if (visited.has(taskId)) {
    return false;
  }
  visited.add(taskId);
  const task = byId.get(taskId);
  if (!task) {
    return false;
  }
  if (task.dependencies.includes(dependencyId)) {
    return true;
  }
  return task.dependencies.some((dependency) =>
    dependsOn(dependency, dependencyId, byId, visited),
  );
}

export function serializeBuilderConflicts(
  tasks: readonly SubagentTask[],
  options: Omit<TaskGraphValidationOptions, "conflictPolicy"> = {},
): TaskGraphSerialization {
  const validation = validateTaskGraph(tasks, {
    ...options,
    conflictPolicy: "ignore",
  });
  if (!validation.valid) {
    throw new TaskGraphValidationError(validation);
  }

  const normalizedTasks = tasks.map((task) => ({
    ...task,
    dependencies: [...new Set(task.dependencies)],
    fileScope: task.fileScope.map(normalizeFileScope),
  }));
  const byId = new Map(normalizedTasks.map((task) => [task.id, task]));
  const position = new Map(
    validation.topologicalOrder.map((taskId, index) => [taskId, index]),
  );
  const addedDependencies: TaskSerializationEdge[] = [];

  for (const conflict of validation.conflicts) {
    const [left, right] = conflict.taskIds;
    const leftPosition = position.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightPosition = position.get(right) ?? Number.MAX_SAFE_INTEGER;
    const [earlier, later] =
      leftPosition <= rightPosition ? [left, right] : [right, left];
    const laterTask = byId.get(later);
    if (!laterTask || dependsOn(later, earlier, byId)) {
      continue;
    }
    laterTask.dependencies.push(earlier);
    addedDependencies.push({
      taskId: later,
      dependsOn: earlier,
      scopes: [...conflict.scopes],
    });
  }

  return {
    tasks: normalizedTasks,
    conflicts: validation.conflicts,
    addedDependencies,
  };
}
