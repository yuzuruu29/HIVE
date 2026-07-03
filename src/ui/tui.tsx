import React, { useState, useEffect } from 'react';
import { render } from 'ink';
import { Box, Text, useInput, useApp } from 'ink';
import TextInput from 'ink-text-input';
import { TaskStore } from '../store.js';
import { ProviderRegistry } from '../providers/registry.js';
import { ConfigStore, HiveMode } from '../config.js';
import { TaskRecord } from '../types.js';
import { ProviderConfig, ProviderRoles } from '../providers/types.js';
import path from 'node:path';
import fs from 'node:fs/promises';

interface TuiProps {
  cwd: string;
}

type Pane = 'dashboard' | 'transcripts' | 'diff';
type ModalState = 'none' | 'run' | 'approve' | 'discard';

export function TuiApp({ cwd }: TuiProps) {
  const { exit } = useApp();
  
  const [activePane, setActivePane] = useState<Pane>('dashboard');
  const [modal, setModal] = useState<ModalState>('none');
  const [inputText, setInputText] = useState('');
  const [isExecuting, setIsExecuting] = useState(false);
  const [lastOutput, setLastOutput] = useState('');
  const [fullPatch, setFullPatch] = useState<string | null>(null);

  const [mode, setMode] = useState<HiveMode>('guarded');
  const [providers, setProviders] = useState<ProviderConfig[]>([]);
  const [roles, setRoles] = useState<ProviderRoles>({});
  const [tasks, setTasks] = useState<TaskRecord[]>([]);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  const loadData = async () => {
    const store = new TaskStore(cwd);
    const registry = new ProviderRegistry(cwd);
    const configStore = new ConfigStore(cwd);

    setMode(await configStore.getMode());
    setProviders(await registry.list());
    setRoles(await registry.getRoles());
    setTasks(await store.list());
    
    let currentId = null;
    try {
      const p = path.join(cwd, ".hivemind", "coder-tasks", "active-task.txt");
      const id = await fs.readFile(p, "utf-8");
      currentId = id.trim();
      setActiveTaskId(currentId);
    } catch (e) {
      setActiveTaskId(null);
    }

    if (currentId) {
      try {
        const patchPath = path.join(cwd, ".hivemind", "coder-tasks", currentId, "diff.patch");
        const diffStr = await fs.readFile(patchPath, "utf-8");
        setFullPatch(diffStr);
      } catch (e) {
        setFullPatch(null);
      }
    } else {
      setFullPatch(null);
    }
  };

  useEffect(() => {
    loadData();
    const interval = setInterval(loadData, 2000);
    return () => clearInterval(interval);
  }, [cwd]);

  const executeAction = async (args: string[]) => {
    setIsExecuting(true);
    setModal('none');
    setLastOutput(`Executing: hive ${args.join(' ')}...`);
    try {
      const { runCoderCli } = await import('../cli.js');
      const res = await runCoderCli(args, { cwd });
      setLastOutput(res.output);
    } catch (e: any) {
      setLastOutput(`Error: ${e.message}`);
    }
    await loadData();
    setIsExecuting(false);
  };

  useInput((input, key) => {
    if (isExecuting) return; // Block inputs during execution
    
    // Global quit
    if (modal === 'none' && (key.escape || input === 'q')) {
      exit();
      return;
    }

    if (key.escape) {
      setModal('none');
      setInputText('');
      return;
    }

    if (modal === 'approve') {
      if (input.toLowerCase() === 'y') executeAction(['approve']);
      else if (input.toLowerCase() === 'n') setModal('none');
      return;
    }

    if (modal === 'discard') {
      if (input.toLowerCase() === 'y') executeAction(['discard']);
      else if (input.toLowerCase() === 'n') setModal('none');
      return;
    }

    if (modal === 'run') {
      // ink-text-input handles most keys. We only intercept Enter.
      if (key.return) {
        if (inputText.trim()) executeAction(['run', inputText.trim()]);
        setModal('none');
        setInputText('');
      }
      return;
    }

    if (input === 'd') setActivePane('diff');
    if (input === 't') setActivePane('transcripts');
    if (input === 's') setActivePane('dashboard');
    if (input === 'p') setActivePane('dashboard');

    if (input === 'r') {
      setInputText('');
      setModal('run');
    }
    if (input === 'a') {
      const activeTask = tasks.find(t => t.taskId === activeTaskId);
      if (activeTaskId && activeTask?.state === 'AWAITING_APPROVAL') {
        setModal('approve');
      } else {
        setLastOutput("No task awaiting approval.");
      }
    }
    if (input === 'x') {
      if (activeTaskId) setModal('discard');
      else setLastOutput("No active task to discard.");
    }
  });

  const activeTask = tasks.find(t => t.taskId === activeTaskId);

  return (
    <Box flexDirection="column" width="100%" height="100%" minHeight={20}>
      <Box borderStyle="round" borderColor="magenta" paddingX={1} marginBottom={1} flexDirection="row">
        <Text color="magenta" bold>[HIVE] </Text>
        <Text color="gray">- </Text>
        <Text color="magenta">Hyper Intelligence for Verified Engineering</Text>
      </Box>

      {/* MODALS */}
      {modal === 'run' && (
        <Box borderStyle="single" borderColor="yellow" padding={1} marginBottom={1}>
          <Text bold color="yellow">New Task Prompt: </Text>
          <TextInput value={inputText} onChange={setInputText} />
        </Box>
      )}

      {modal === 'approve' && (
        <Box borderStyle="single" borderColor="green" padding={1} marginBottom={1}>
          <Text bold color="green">Approve this patch for commit? </Text>
          <Text color="white">[y/N]</Text>
        </Box>
      )}

      {modal === 'discard' && (
        <Box borderStyle="single" borderColor="red" padding={1} marginBottom={1}>
          <Text bold color="red">Discard this cell and worktree? </Text>
          <Text color="white">[y/N]</Text>
        </Box>
      )}

      {isExecuting && (
        <Box borderStyle="single" borderColor="cyan" padding={1} marginBottom={1}>
          <Text bold color="cyan">Executing... Swarm is working.</Text>
        </Box>
      )}

      {!isExecuting && lastOutput && modal === 'none' && (
        <Box borderStyle="single" borderColor="gray" padding={1} marginBottom={1}>
          <Text>{lastOutput}</Text>
        </Box>
      )}

      {/* PANES */}
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
                <Text color="green">[OK] Worktree verified</Text>
                <Text color="green">[OK] Approval required before commit</Text>
                <Text color="green">[OK] No auto-push</Text>
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
                    <Text>{roles.planner ? `${roles.planner.provider} / ${roles.planner.model}` : "Unassigned"}</Text>
                    <Text>{roles.builder ? `${roles.builder.provider} / ${roles.builder.model}` : "Unassigned"}</Text>
                    <Text>{roles.validator ? `${roles.validator.provider} / ${roles.validator.model}` : "Unassigned"}</Text>
                    <Text>{roles.reviewer ? `${roles.reviewer.provider} / ${roles.reviewer.model}` : "Unassigned"}</Text>
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
                        <Text color="gray">  Press [x] to discard</Text>
                        <Text color="gray">  Press [r] to run new task</Text>
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
          {!activeTaskId || !activeTask?.transcripts || Object.keys(activeTask.transcripts).length === 0 ? (
            <Text color="gray">No swarm transcript available yet.</Text>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              {Object.entries(activeTask.transcripts).map(([role, logs]) => (
                <Box key={role} flexDirection="column" marginBottom={1}>
                  <Text bold color="cyan">{role}:</Text>
                  {logs.map((log, idx) => (
                    <Text key={idx} color="gray">  {log.substring(0, 150)}{log.length > 150 ? '...' : ''}</Text>
                  ))}
                </Box>
              ))}
            </Box>
          )}
        </Box>
      )}

      {activePane === 'diff' && (
        <Box borderStyle="single" borderColor="green" padding={1} flexGrow={1} flexDirection="column">
          <Text bold color="green">Patch Diff ({activeTaskId || "None"})</Text>
          {!activeTaskId || !activeTask?.diffSummary ? (
            <Text color="gray">No patch available for this cell yet.</Text>
          ) : (
            <Box flexDirection="column" marginTop={1}>
              <Text bold color="white">Summary:</Text>
              <Text color="gray">Files Changed: {activeTask.diffSummary.filesChanged.join(', ') || 'None'}</Text>
              <Text color="green">Insertions: {activeTask.diffSummary.insertions}</Text>
              <Text color="red">Deletions: {activeTask.diffSummary.deletions}</Text>
              
              <Box marginTop={1} flexDirection="column">
                <Text bold color="white">Full Patch:</Text>
                {fullPatch ? (
                  <Text color="gray">
                    {fullPatch.substring(0, 1000)}
                    {fullPatch.length > 1000 ? '\n... (truncated)' : ''}
                  </Text>
                ) : (
                  <Text color="gray">Loading or unavailable...</Text>
                )}
              </Box>
            </Box>
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
