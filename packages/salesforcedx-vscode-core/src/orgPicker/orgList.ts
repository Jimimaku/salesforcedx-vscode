/*
 * Copyright (c) 2019, salesforce.com, inc.
 * All rights reserved.
 * Licensed under the BSD 3-Clause license.
 * For full license text, see LICENSE.txt file in the repo root or https://opensource.org/licenses/BSD-3-Clause
 */
import { AuthFields, AuthInfo, OrgAuthorization } from '@salesforce/core';
import {
  CancelResponse,
  ContinueResponse
} from '@salesforce/salesforcedx-utils-vscode/out/src/types';
import * as vscode from 'vscode';
import { OrgInfo, workspaceContext } from '../context';
import { nls } from '../messages';
import { hasRootWorkspace, OrgAuthInfo } from '../util';

export interface FileInfo {
  scratchAdminUsername?: string;
  isDevHub?: boolean;
  username: string;
  devHubUsername?: string;
  expirationDate?: string;
}
export class OrgList implements vscode.Disposable {
  private statusBarItem: vscode.StatusBarItem;

  constructor() {
    this.statusBarItem = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      49
    );
    this.statusBarItem.command = 'sfdx.force.set.default.org';
    this.statusBarItem.tooltip = nls.localize('status_bar_org_picker_tooltip');
    this.statusBarItem.show();

    workspaceContext.onOrgChange((orgInfo: OrgInfo) =>
      this.displayDefaultUsername(orgInfo.alias || orgInfo.username)
    );
    const { username, alias } = workspaceContext;
    this.displayDefaultUsername(alias || username);
  }

  public displayDefaultUsername(defaultUsernameOrAlias?: string) {
    if (defaultUsernameOrAlias) {
      this.statusBarItem.text = `$(plug) ${defaultUsernameOrAlias}`;
    } else {
      this.statusBarItem.text = nls.localize('missing_default_org');
    }
  }

  public async getOrgAuthorizations(): Promise<OrgAuthorization[] | null> {
    const orgAuthorizations = await AuthInfo.listAllAuthorizations().catch(
      err => null
    );

    if (orgAuthorizations === null || orgAuthorizations.length === 0) {
      return null;
    }

    return orgAuthorizations;
  }

  public async filterAuthInfo(
    authInfoObjects: OrgAuthorization[] | FileInfo[]
  ) {
    const defaultDevHubUsernameorAlias = await this.getDefaultDevHubUsernameorAlias();
    let defaultDevHubUsername: string | undefined;
    if (defaultDevHubUsernameorAlias) {
      defaultDevHubUsername = await OrgAuthInfo.getUsername(
        defaultDevHubUsernameorAlias
      );
    }

    const authList = [];
    const today = new Date();
    for (const authInfo of authInfoObjects as OrgAuthorization[]) {
      // TODO: Does this do the same thing as info.getKeysByValue(authInfo.username)
      const authInfoType: AuthInfo = await AuthInfo.create({
        username: authInfo.username
      });
      const authFields: AuthFields = authInfoType.getFields();
      if (authFields.scratchAdminUsername) {
        continue;
      }
      if (
        authFields.devHubUsername &&
        authFields.devHubUsername !== defaultDevHubUsername
      ) {
        continue;
      }
      const aliases = authInfo.aliases;
      const isExpired = authFields.expirationDate
        ? today >= new Date(authFields.expirationDate)
        : false;
      let authListItem =
        aliases && aliases?.length > 0
          ? `${aliases} - ${authInfo.username}`
          : authInfo.username;

      if (isExpired) {
        authListItem += ` - ${nls.localize(
          'org_expired'
        )} ${String.fromCodePoint(0x274c)}`; // cross-mark
      }

      authList.push(authListItem);
    }
    return authList;
  }

  public async updateOrgList() {
    const orgAuthorizations:
      | OrgAuthorization[]
      | null = await this.getOrgAuthorizations();
    if (!orgAuthorizations) {
      return null;
    }
    const authUsernameList = await this.filterAuthInfo(
      orgAuthorizations as OrgAuthorization[]
    );
    return authUsernameList;
  }

  public async setDefaultOrg(): Promise<CancelResponse | ContinueResponse<{}>> {
    let quickPickList = [
      '$(plus) ' + nls.localize('force_auth_web_login_authorize_org_text'),
      '$(plus) ' + nls.localize('force_auth_web_login_authorize_dev_hub_text'),
      '$(plus) ' + nls.localize('force_org_create_default_scratch_org_text'),
      '$(plus) ' + nls.localize('force_auth_access_token_authorize_org_text'),
      '$(plus) ' + nls.localize('force_org_list_clean_text')
    ];

    const authInfoList = await this.updateOrgList();
    if (authInfoList) {
      quickPickList = quickPickList.concat(authInfoList);
    }

    const selection = await vscode.window.showQuickPick(quickPickList, {
      placeHolder: nls.localize('org_select_text')
    });

    if (!selection) {
      return { type: 'CANCEL' };
    }
    switch (selection) {
      case '$(plus) ' +
        nls.localize('force_auth_web_login_authorize_org_text'): {
        vscode.commands.executeCommand('sfdx.force.auth.web.login');
        return { type: 'CONTINUE', data: {} };
      }
      case '$(plus) ' +
        nls.localize('force_auth_web_login_authorize_dev_hub_text'): {
        vscode.commands.executeCommand('sfdx.force.auth.dev.hub');
        return { type: 'CONTINUE', data: {} };
      }
      case '$(plus) ' +
        nls.localize('force_org_create_default_scratch_org_text'): {
        vscode.commands.executeCommand('sfdx.force.org.create');
        return { type: 'CONTINUE', data: {} };
      }
      case '$(plus) ' +
        nls.localize('force_auth_access_token_authorize_org_text'): {
        vscode.commands.executeCommand('sfdx.force.auth.accessToken');
        return { type: 'CONTINUE', data: {} };
      }
      case '$(plus) ' + nls.localize('force_org_list_clean_text'): {
        vscode.commands.executeCommand('sfdx.force.org.list.clean');
        return { type: 'CONTINUE', data: {} };
      }
      default: {
        const usernameOrAlias = selection.split(' - ', 1);
        vscode.commands.executeCommand(
          'sfdx.force.config.set',
          usernameOrAlias
        );
        return { type: 'CONTINUE', data: {} };
      }
    }
  }

  public async getDefaultDevHubUsernameorAlias(): Promise<string | undefined> {
    if (hasRootWorkspace()) {
      return OrgAuthInfo.getDefaultDevHubUsernameOrAlias(false);
    }
  }

  public dispose() {
    this.statusBarItem.dispose();
  }
}
