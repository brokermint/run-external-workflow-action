import * as core from '@actions/core';
import { Octokit } from '@octokit/action';

import unzipper from 'unzipper';


const wait = async (seconds) => {
  return new Promise((resolve) => {
  if (isNaN(seconds)) {
    throw new Error('seconds not a number');
  }

  setTimeout(() => resolve(), seconds * 1000);
  });
};

async function run() {
  core.info('Started');

  //  Input arguments
  const repo = core.getInput('repo_name');
  const owner = core.getInput('repo_owner');
  const workflowFileName = core.getInput('workflow_file_name');
  const githubToken = core.getInput('github_token');
  const gitRef = core.getInput('git_ref') || 'master';
  const checkInterval = core.getInput('check_interval') || '5';
  const waitTimeout = core.getInput('wait_timeout') || '600';
  const clientPayload = core.getInput('client_payload') || '{}';

  // ############## Get a workflow
  const octokit = new Octokit({ auth: githubToken });
  let workflows;
  try {
    workflows = (await octokit.actions.listRepoWorkflows({ repo, owner })).data.workflows;
  }
  catch (error) {
    core.error("Provided GITHUB_TOKEN has no permissions to access the remote repo actions");
    throw error;
  }

  const workflow = workflows.find((w) => w.path.endsWith(workflowFileName));
  if (!workflow) {
    throw new Error(`Cannot find workflow: '${workflowFileName}', available workflows: '${workflows.map((w) => w.path).join("', '")}'`);
  }
  core.info(`Detected workflow id: ${workflow.id}`);

  // ############## Get last run id before our run (needed to detect a new run id)
  const getLastWorkflowRunId = async () => {
    const workflowRuns = (await octokit.actions.listWorkflowRuns({
      workflow_id: workflow.id,
      per_page: 1,
      repo,
      owner
    })).data.workflow_runs;
    return workflowRuns[0]?.id;
  };
  const lastWorkflowRunId = await getLastWorkflowRunId();

  // ############## Trigger workflow run, it returns no response
  const inputs = JSON.parse(clientPayload);
  await octokit.actions.createWorkflowDispatch({ workflow_id: workflow.id, inputs, ref: gitRef, repo, owner });
  // ############## Detect our workflow run id
  // There's no way to get exact run id created by dispatching an action,
  // we assume that first newer id that appears in "/runs" is our action run
  let workflowRunId = await getLastWorkflowRunId();
  const searchUntilTime = new Date().getTime() + 60 * 1000; // 1 minute
  core.info('Scheduled workflow run, waiting for start');
  while (workflowRunId === lastWorkflowRunId) {
    await wait(2);
    workflowRunId = await getLastWorkflowRunId();
    if (new Date().getTime() > searchUntilTime) {
      throw new Error('Cannot detect workflow run id');
    }
  }
  core.info('Workflow started 🚀');

  // ############## Wait until our workflow run is completed
  const waitUntilTime = new Date().getTime() + parseInt(waitTimeout) * 1000;
  let workflowRun = (await octokit.actions.getWorkflowRun({ run_id: workflowRunId, repo, owner })).data;
  core.info(`Real time logs can be viewed here: ${workflowRun.html_url}`);
  core.info('Waiting for complete...');
  const waitInterval = parseInt(checkInterval);
  let lastDotLogTime = new Date().getTime();
  while (workflowRun.status !== 'completed') {
    await wait(waitInterval);
    workflowRun = (await octokit.actions.getWorkflowRun({ run_id: workflowRunId, repo, owner })).data;
    if (new Date().getTime() - lastDotLogTime > 15000) { // log a dot no more often than every 15 seconds
      core.info('.');
      lastDotLogTime = new Date().getTime();
    }
    if (new Date().getTime() > waitUntilTime) {
      throw new Error(`Workflow execution time is too long, waited ${waitTimeout} seconds`);
    }
  }

  // ############## Download run logs
  const logData = (await octokit.actions.downloadWorkflowRunLogs({ run_id: workflowRunId, attempt_number: 1, repo, owner })).data;
  const directory = await unzipper.Open.buffer(Buffer.from(logData));
  // find a file with shortest name
  let generalLogFile = directory.files.find((f) => f.type === 'File');
  for (const file of directory.files) {
    core.info(` processing log: ${file.path}`)
    const currentPathLength = generalLogFile ? generalLogFile.path.length : 0;
    if (file.type === 'File' && currentPathLength > file.path.length) {
      generalLogFile = file;
    }
  }
  if (!generalLogFile) {
    throw Error('No files were found in logs archive');
  }

  core.info(`log file ${generalLogFile.path}`)

  const textBuffer = await generalLogFile.buffer();
  const text = textBuffer.toString();

  // ############## Proxy logs to STDOUT
  for (const line of text.split('\n')) {
    // filter some Docker logs
    if (line.trim().match(/(Pulling fs layer|Waiting|Verifying Checksum|Download complete|Pull complete)$/))
      continue;
    // filter some git logs
    if (line.match(/remote: Counting objects|remote: Compressing objects/))
      continue;
    core.info(line);
  }
  return workflowRun.conclusion === "success";
}

async function main() {
  try {
    const succeeded = await run();
    if (!succeeded)
      core.setFailed('External workflow failed.');
  }
  catch (error) {
    if (error instanceof Error)
      core.setFailed(error.message);
  }
}

export default main;
