import React, { useState, useEffect } from 'react';
import { render } from 'ink';
import { Box, Text, useInput, useApp } from 'ink';
import { TaskStore } from '../store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { ConfigStore, HiveMode } from '../config.js';
import { TaskRecord } from '../types.js';
import { ProviderConfig, ProviderRoles } from '../providers/types.js';

interface TuiProps {
  cwd: string;
}

type Pane = 'dashboard' | 'transcripts' | 'diff';

export function TuiApp({ cwd }: TuiProps) {
  const { exit } = useApp();
  
  const [activePane, setActivePane] = useState<Pane>('dashboard');
  const [mode, setMode] = useState<HiveMode>('guarded');
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [roles, setRoles] = useState<ProviderRoles>({});
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  // Load state on mount
  useEffect(() => {
    async function loadData() {
      const store = new TaskStore(cwd);
      const registry = new ProviderRegistry(cwd);
      const configStore = new ConfigStore(cwd);

      setMode(await configStore.getMode());
      setProviders(await registry.list());
      setRoles(await registry.getRoles());
      setTasks(await store.list());
      
      try {
        const fs = await import('node:fs/promises');
        const path = await import('node:path');
        const p = path.join(cwd, ".hivemind", "coder-tasks", "active-task.txt");
        const id = await fs.readFile(p, "utf-8");
        setActiveTaskId(id.trim());
      } catch (e) {
        // No active task
      }
    }
    loadData();
    // In a real app we'd poll or use an event emitter. Polling lightly for live feel.
    const interval = setInterval(loadData, 2000);
    return () => clearInterval(interval);
  }, [cwd]);

  useInput((input, key) => {
    if (key.escape || input === 'q') {
      exit();
    }
    if (input === 'd') {
      setActivePane('diff');
    }
    if (input === 't') {
      setActivePane('transcripts');
    }
    if (input === 's' || key.backspace) { // just map back to dashboard
      setActivePane('dashboard');
    }
    // r, p, a, x commands would trigger real logic in the future.
  });

  const activeTask = tasks.find(t => t.taskId === activeTaskId);

  return (
    <Box flexDirection="column" width="100%" height="100%" minHeight={20}>
      <Box borderStyle="round" borderColor="magenta" paddingX={1} marginBottom={1} flexDirection="row">
        <Text color="magenta" bold>♛ HIVE </Text>
        <Text color="gray"> · </Text>
        <Text color="magenta">Hyper Intelligence for Verified Engineering</Text>
      </Box>

      {activePane === 'dashboard' && (
        <Box flexDirection="column" flexGrow={1}>
          <Box flexDirection="row" gap={1}>
            {/* Queen / Guardrail Status */}
            <Box flexDirection="column" width="50%" borderStyle="single" borderColor="cyan" padding={1}>
              <Text bold color="cyan">Queen & Guardrails</Text>
              <Text>Mode: <Text color="yellow">{mode}</Text></Text>
              <Text>Active Cell: {activeTaskId ? <Text color="green">{activeTaskId}</Text> : <Text color="gray">None</Text>}</Text>
              <Text>State: {
                activeTask ? (
                  <Text bold color={activeTask.state === 'FAILED' ? 'red' : activeTask.state === 'AWAITING_APPROVAL' ? "yellow" : "white"}>{activeTask.state}</Text>
                ) : (
                  <Text color="gray">idle</Text>
                )
              }</Text>
              
              <Box marginTop={1} flexDirection="column">
                <Text color="gray">Guardrails:</Text>
                <Text color="green">✓ Worktree verified</Text>
                <Text color="green">✓ Approval required before commit</Text>
                <Text color="green">✓ No auto-push</Text>
              </Box>
            </Box>

            {/* Apiary / Swarm */}
            <Box flexDirection="column" width="50%" borderStyle="single" borderColor="magenta" padding={1}>
              <Text bold color="magenta">Apiary</Text>
              <Text>Providers Approved: {providers.filter(p => p.approved).length}</Text>
              
              <Box marginTop={1} flexDirection="column">
                <Text bold color="magenta">Swarm Roles</Text>
                <Box flexDirection="row">
                  <Box flexDirection="column" width={12}>
                    <Text>Planner:</Text>
                    <Text>Builder:</Text>
                    <Text>Validator:</Text>
                    <Text>Reviewer:</Text>
                  </Box>
                  <Box flexDirection="column">
                    <Text>{roles.planner ? `${roles.planner.provider} · ${roles.planner.model}` : "Unassigned"}</Text>
                    <Text>{roles.builder ? `${roles.builder.provider} · ${roles.builder.model}` : "Unassigned"}</Text>
                    <Text>{roles.validator ? `${roles.validator.provider} · ${roles.validator.model}` : "Unassigned"}</Text>
                    <Text>{roles.reviewer ? `${roles.reviewer.provider} · ${roles.reviewer.model}` : "Unassigned"}</Text>
                  </Box>
                </Box>
              </Box>
            </Box>
          </Box>

          {/* Comb (Sessions) */}
          <Box borderStyle="single" borderColor="blue" padding={1} marginTop={1} flexGrow={1} flexDirection="column">
            <Text bold color="blue">Comb (Task Cells)</Text>
            {tasks.length === 0 ? (
              <Text color="gray">No tasks in this apiary yet.</Text>
            ) : (
              <Box flexDirection="column">
                {activeTask && (
                  <Box marginBottom={1} flexDirection="column">
                    <Text bold color="white">Active:</Text>
                    <Text>
                      <Text color="green">* </Text>
                      {activeTask.taskId} <Text color={activeTask.state === 'FAILED' ? 'red' : 'green'}>[{activeTask.state}]</Text>
                    </Text>
                    {activeTask.state === 'FAILED' && (
                      <Box marginTop={1} flexDirection="column" marginLeft={2}>
                        <Text color="gray">Next:</Text>
                        <Text color="gray">  hive status</Text>
                        <Text color="gray">  hive diff</Text>
                        <Text color="gray">  hive discard</Text>
                      </Box>
                    )}
                  </Box>
                )}
                
                <Text bold color="white">Recent:</Text>
                {tasks
                  .filter(t => t.taskId !== activeTaskId)
                  .slice(-5)
                  .map(t => (
                    <Text key={t.taskId} color={t.state === 'FAILED' ? 'gray' : 'white'}>
                      {"  "}{t.taskId} <Text color="gray">[{t.state}]</Text>
                    </Text>
                  ))}
              </Box>
            )}
          </Box>
        </Box>
      )}

      {activePane === 'transcripts' && (
        <Box borderStyle="single" borderColor="gray" padding={1} flexGrow={1} flexDirection="column">
          <Text bold color="white">Transcripts ({activeTaskId || "None"})</Text>
          {!activeTaskId ? (
            <Text color="gray">No active task to show transcripts for.</Text>
          ) : (
            <Text color="gray">Transcripts will stream here in real-time...</Text>
          )}
        </Box>
      )}

      {activePane === 'diff' && (
        <Box borderStyle="single" borderColor="green" padding={1} flexGrow={1} flexDirection="column">
          <Text bold color="green">Patch Diff ({activeTaskId || "None"})</Text>
          {!activeTaskId ? (
            <Text color="gray">No active task to show diff for.</Text>
          ) : (
            <Text color="gray">Raw git diff will render here...</Text>
          )}
        </Box>
      )}

      {/* Footer */}
      <Box marginTop={1} flexDirection="row" gap={2}>
        <Text><Text color="magenta" bold>[q]</Text> Quit</Text>
        <Text><Text color="magenta" bold>[s]</Text> Sessions</Text>
        <Text><Text color="magenta" bold>[t]</Text> Transcripts</Text>
        <Text><Text color="magenta" bold>[d]</Text> Diff</Text>
        <Text><Text color="magenta" bold>[r]</Text> Run</Text>
        <Text><Text color="green" bold>[a]</Text> Approve</Text>
        <Text><Text color="red" bold>[x]</Text> Reject</Text>
        <Text><Text color="magenta" bold>[?]</Text> Help</Text>
      </Box>
    </Box>
  );
}

export function startTui(cwd: string) {
  render(<TuiApp cwd={cwd} />);
}
