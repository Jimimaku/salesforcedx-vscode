/*
 * Copyright (c) 2020, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */

import { LibraryCommandletExecutor } from '@salesforce/salesforcedx-utils-vscode/out/src';
import {
  CancelResponse,
  ContinueResponse,
  FunctionInfo,
  ParametersGatherer
} from '@salesforce/salesforcedx-utils-vscode/out/src/types';
import * as cp from 'child_process';
import * as path from 'path';
import * as vscode from 'vscode';
import { channelService, OUTPUT_CHANNEL } from '../../channels';
import { nls } from '../../messages';
import { notificationService } from '../../notifications';
import { MetadataDictionary, MetadataInfo } from '../../util';
import {
  CompositeParametersGatherer,
  SelectFileName,
  SfdxCommandlet,
  SfdxWorkspaceChecker
} from '../util';
import { FUNCTION_TYPE_JAVA, FUNCTION_TYPE_JS } from './metadataTypeConstants';

import { generateFunction, Language } from '@heroku/functions-core';
import { getRootWorkspacePath } from '../../util';

const LANGUAGE_JAVA = 'java';
const LANGUAGE_JAVASCRIPT = 'javascript';
const LANGUAGE_TYPESCRIPT = 'typescript';

const LOG_NAME = 'force_function_create';
export class ForceFunctionCreateExecutor extends LibraryCommandletExecutor<
  any
> {
  constructor() {
    super(nls.localize('force_function_create_text'), LOG_NAME, OUTPUT_CHANNEL);
  }
  public async run(response: ContinueResponse<FunctionInfo>): Promise<boolean> {
    const { fileName, language } = response.data;
    let metadata: MetadataInfo | undefined;
    switch (language) {
      case LANGUAGE_JAVASCRIPT:
        metadata = MetadataDictionary.getInfo(FUNCTION_TYPE_JS);
        metadata!.suffix = '.js';
        this.telemetry.addProperty('language', 'node');
        break;
      case LANGUAGE_TYPESCRIPT:
        metadata = MetadataDictionary.getInfo(FUNCTION_TYPE_JS);
        metadata!.suffix = '.ts';
        this.telemetry.addProperty('language', 'node');
        break;
      case LANGUAGE_JAVA:
        metadata = MetadataDictionary.getInfo(FUNCTION_TYPE_JAVA);
        metadata!.suffix = '.java';
        this.telemetry.addProperty('language', 'java');
        break;
    }
    const { path: functionPath, welcomeText } = await generateFunction(
      fileName,
      language as Language,
      getRootWorkspacePath()
    );
    channelService.appendLine(
      `Created ${language} function ${fileName} in ${functionPath}.`
    );
    if (welcomeText) channelService.appendLine(welcomeText);
    channelService.showChannelOutput();
    const outputFile = metadata!.pathStrategy.getPathToSource(
      functionPath,
      fileName,
      metadata!.suffix
    );
    const document = await vscode.workspace.openTextDocument(outputFile);
    vscode.window.showTextDocument(document);
    channelService.appendLine('Installing dependencies...');

    if (language === LANGUAGE_JAVA) {
      cp.exec('mvn install', { cwd: path.join(functionPath) }, err => {
        if (err) {
          notificationService.showWarningMessage(
            nls.localize(
              'force_function_install_mvn_dependencies_error',
              err.message
            )
          );
        }
      });
    } else {
      cp.exec('npm install', { cwd: functionPath }, err => {
        if (err) {
          notificationService.showWarningMessage(
            nls.localize(
              'force_function_install_npm_dependencies_error',
              err.message
            )
          );
        }
      });
    }

    return true;
  }
}

export class FunctionInfoGatherer implements ParametersGatherer<{ language: string }> {
  public async gather(): Promise<
    CancelResponse | ContinueResponse<{ language: string }>
  > {
    const language = await vscode.window.showQuickPick(
      [LANGUAGE_JAVA, LANGUAGE_JAVASCRIPT, LANGUAGE_TYPESCRIPT],
      {
        placeHolder: nls.localize('force_function_enter_language')
      }
    );

    if (language === undefined) {
      return { type: 'CANCEL' };
    }

    return {
      type: 'CONTINUE',
      data: {
        language
      }
    };
  }
}

function nameVerification(value: string) {
  if (value.length > 47) {
    throw new Error('Function names cannot contain more than 47 characters.');
  }
  const functionNameRegex = /^[a-z0-9]+$/;
  if (!functionNameRegex.test(value)) {
    throw new Error('Name must contain only lowercase letters and numbers.');
  }
  const functionNameStartRegex = /^[a-z]/;
  if (!functionNameStartRegex.test(value)) {
    throw new Error('Name must start with a letter.');
  }
  return '';
} // TODO move to appropriate class/package and/or localize strings

const parameterGatherer = new CompositeParametersGatherer(
  new SelectFileName({
    prompt: nls.localize('force_function_enter_function'),
    validateInput: value => {
      try {
        nameVerification(value);
      } catch (error) {
        return error.message;
      }
      return null;
    }
  }),
  new FunctionInfoGatherer()
);

export async function forceFunctionCreate() {
  const commandlet = new SfdxCommandlet(
    new SfdxWorkspaceChecker(),
    parameterGatherer,
    new ForceFunctionCreateExecutor()
  );
  await commandlet.run();
}
