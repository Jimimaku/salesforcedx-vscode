/*
 * Copyright (c) 2019, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import {
  CliCommandExecutor,
  Command,
  DiffResultParser,
  SfdxCommandBuilder
} from '@salesforce/salesforcedx-utils-vscode/out/src/cli';
import { ContinueResponse } from '@salesforce/salesforcedx-utils-vscode/out/src/types';
import { SourceComponent } from '@salesforce/source-deploy-retrieve';
import * as path from 'path';
import * as vscode from 'vscode';
import { channelService } from '../channels';
import { CommonDirDirectoryDiffer, conflictView } from '../conflict';
import {
  MetadataCacheExecutor,
  MetadataCacheResult
} from '../conflict/metadataCacheService';
import { workspaceContext } from '../context';
import { nls } from '../messages';
import { notificationService, ProgressNotification } from '../notifications';
import { taskViewService } from '../statuses';
import { telemetryService } from '../telemetry';
import { getRootWorkspacePath, hasRootWorkspace, OrgAuthInfo } from '../util';
import {
  FilePathGatherer,
  SfdxCommandlet,
  SfdxCommandletExecutor,
  SfdxWorkspaceChecker
} from './util';

export class ForceSourceDiffExecutor extends SfdxCommandletExecutor<string> {
  public build(filePath: string): Command {
    const commandBuilder = new SfdxCommandBuilder()
      .withDescription(nls.localize('force_source_diff_text'))
      .withArg('force:source:diff')
      .withLogName('force_source_diff')
      .withFlag('--sourcepath', filePath)
      .withJson();
    return commandBuilder.build();
  }

  public async execute(response: ContinueResponse<string>): Promise<void> {
    const startTime = process.hrtime();
    const cancellationTokenSource = new vscode.CancellationTokenSource();
    const cancellationToken = cancellationTokenSource.token;

    const execution = new CliCommandExecutor(this.build(response.data), {
      cwd: getRootWorkspacePath(),
      env: { SFDX_JSON_TO_STDOUT: 'true' }
    }).execute(cancellationToken);

    channelService.streamCommandStartStop(execution);

    let stdOut = '';
    execution.stdoutSubject.subscribe(realData => {
      stdOut += realData.toString();
    });

    execution.processExitSubject.subscribe(async exitCode => {
      this.logMetric(execution.command.logName, startTime);
      await handleDiffResponse(exitCode, stdOut);
    });

    notificationService.reportCommandExecutionStatus(
      execution,
      cancellationToken
    );
    ProgressNotification.show(execution, cancellationTokenSource);
    taskViewService.addCommandExecution(execution, cancellationTokenSource);
  }
}

export async function handleDiffResponse(
  exitCode: number | undefined,
  stdOut: string
) {
  try {
    if (exitCode === 127) {
      throw new Error(nls.localize('force_source_diff_command_not_found'));
    }
    const diffParser = new DiffResultParser(stdOut);
    const diffParserSuccess = diffParser.getSuccessResponse();
    const diffParserError = diffParser.getErrorResponse();

    if (diffParserSuccess) {
      const diffResult = diffParserSuccess.result;
      const remote = vscode.Uri.file(diffResult.remote);
      const local = vscode.Uri.file(diffResult.local);
      const filename = diffResult.fileName;

      let defaultUsernameorAlias: string | undefined;
      if (hasRootWorkspace()) {
        defaultUsernameorAlias = await OrgAuthInfo.getDefaultUsernameOrAlias(
          false
        );
      }
      vscode.commands.executeCommand(
        'vscode.diff',
        remote,
        local,
        nls.localize(
          'force_source_diff_title',
          defaultUsernameorAlias,
          filename,
          filename
        )
      );
    } else if (diffParserError) {
      channelService.appendLine(diffParserError.message);
      channelService.showChannelOutput();
    }
  } catch (e) {
    notificationService.showErrorMessage(e.message);
    channelService.appendLine(e.message);
    channelService.showChannelOutput();
    telemetryService.sendException(e.name, e.message);
  }
}

const workspaceChecker = new SfdxWorkspaceChecker();

export async function forceSourceDiff(sourceUri: vscode.Uri) {
  if (!sourceUri) {
    const editor = vscode.window.activeTextEditor;
    if (
      editor &&
      (editor.document.languageId === 'apex' ||
        editor.document.languageId === 'visualforce' ||
        editor.document.fileName.includes('aura') ||
        editor.document.fileName.includes('lwc') ||
        editor.document.fileName.includes('permissionset-meta.xml') ||
        editor.document.fileName.includes('layout-meta.xml'))
    ) {
      sourceUri = editor.document.uri;
    } else {
      const errorMessage = nls.localize('force_source_diff_unsupported_type');
      telemetryService.sendException('unsupported_type_on_diff', errorMessage);
      notificationService.showErrorMessage(errorMessage);
      channelService.appendLine(errorMessage);
      channelService.showChannelOutput();
      return;
    }
  }

  const commandlet = new SfdxCommandlet(
    workspaceChecker,
    new FilePathGatherer(sourceUri),
    new ForceSourceDiffExecutor()
  );
  await commandlet.run();
}

export async function superSourceDiff(explorerPath: vscode.Uri) {
  if (!explorerPath) {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId !== 'forcesourcemanifest') {
      explorerPath = editor.document.uri;
    } else {
      const errorMessage = nls.localize('force_source_diff_unsupported_type');
      telemetryService.sendException('unsupported_type_on_diff', errorMessage);
      notificationService.showErrorMessage(errorMessage);
      channelService.appendLine(errorMessage);
      channelService.showChannelOutput();
      return;
    }
  }

  const username = workspaceContext.username;
  if (!username) {
    notificationService.showErrorMessage('No default org');
    return;
  }

  const commandlet = new SfdxCommandlet(
    new SfdxWorkspaceChecker(),
    new FilePathGatherer(explorerPath),
    new MetadataCacheExecutor(
      username,
      'Source Diff',
      'source-diff-loader',
      handleCacheResults
    )
  );
  await commandlet.run();
}

async function handleCacheResults(cache?: MetadataCacheResult): Promise<void> {
  if (cache) {
    console.log(`PROF-FILE: ${cache.cachePropPath}`);
    if (!cache.selectedIsDirectory && cache.cache.components) {
      await diffOneFile(cache.selectedPath, cache.cache.components[0]);
    } else if (cache.selectedIsDirectory) {
      const localPath = path.join(
        cache.project.baseDirectory,
        cache.project.commonRoot
      );
      const remotePath = path.join(
        cache.cache.baseDirectory,
        cache.cache.commonRoot
      );
      const differ = new CommonDirDirectoryDiffer();
      const diffs = differ.diff(localPath, remotePath);

      conflictView.visualizeDifferences(
        'PDTDevHub2 - File Diffs',
        'PDTDevHub2',
        true,
        diffs
      );
    }
  } else {
    notificationService.showErrorMessage(
      'Selected components are not available in the org'
    );
  }
}

async function diffOneFile(
  localFile: string,
  remoteComponent: SourceComponent
): Promise<void> {
  const filePart = path.basename(localFile);

  for (const filePath of remoteComponent.walkContent()) {
    if (filePath.endsWith(filePart)) {
      const remoteUri = vscode.Uri.file(filePath);
      const localUri = vscode.Uri.file(localFile);

      try {
        await vscode.commands.executeCommand(
          'vscode.diff',
          remoteUri,
          localUri,
          'Source File Diff ( Local File / Org File )'
        );
      } catch (err) {
        console.log(`ERROR: ${err}`);
      }
      return;
    }
  }
}
