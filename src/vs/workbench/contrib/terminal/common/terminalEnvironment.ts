/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * This module contains utility functions related to the environment, cwd and paths.
 */

import * as path from 'vs/base/common/path';
import { URI } from 'vs/base/common/uri';
import { IWorkspaceContextService, IWorkspaceFolder } from 'vs/platform/workspace/common/workspace';
import { IConfigurationResolverService } from 'vs/workbench/services/configurationResolver/common/configurationResolver';
import { sanitizeProcessEnvironment } from 'vs/base/common/processes';
import { IShellLaunchConfig, ITerminalBackend, ITerminalEnvironment, TerminalShellType, WindowsShellType } from 'vs/platform/terminal/common/terminal';
import { IProcessEnvironment, isWindows, language, OperatingSystem } from 'vs/base/common/platform';
import { escapeNonWindowsPath, sanitizeCwd } from 'vs/platform/terminal/common/terminalEnvironment';
import { isString } from 'vs/base/common/types';
import { IHistoryService } from 'vs/workbench/services/history/common/history';
import { ILogService } from 'vs/platform/log/common/log';

export function mergeEnvironments(parent: IProcessEnvironment, other: ITerminalEnvironment | undefined): void {
	if (!other) {
		return;
	}

	// On Windows apply the new values ignoring case, while still retaining
	// the case of the original key.
	if (isWindows) {
		for (const configKey in other) {
			let actualKey = configKey;
			for (const envKey in parent) {
				if (configKey.toLowerCase() === envKey.toLowerCase()) {
					actualKey = envKey;
					break;
				}
			}
			const value = other[configKey];
			if (value !== undefined) {
				_mergeEnvironmentValue(parent, actualKey, value);
			}
		}
	} else {
		Object.keys(other).forEach((key) => {
			const value = other[key];
			if (value !== undefined) {
				_mergeEnvironmentValue(parent, key, value);
			}
		});
	}
}

function _mergeEnvironmentValue(env: ITerminalEnvironment, key: string, value: string | null): void {
	if (typeof value === 'string') {
		env[key] = value;
	} else {
		delete env[key];
	}
}

export function addTerminalEnvironmentKeys(env: IProcessEnvironment, version: string | undefined, locale: string | undefined, detectLocale: 'auto' | 'off' | 'on'): void {
	env['TERM_PROGRAM'] = 'vscode';
	if (version) {
		env['TERM_PROGRAM_VERSION'] = version;
	}
	if (shouldSetLangEnvVariable(env, detectLocale)) {
		env['LANG'] = getLangEnvVariable(locale);
	}
	env['COLORTERM'] = 'truecolor';
}

function mergeNonNullKeys(env: IProcessEnvironment, other: ITerminalEnvironment | undefined) {
	if (!other) {
		return;
	}
	for (const key of Object.keys(other)) {
		const value = other[key];
		if (value !== undefined && value !== null) {
			env[key] = value;
		}
	}
}

async function resolveConfigurationVariables(variableResolver: VariableResolver, env: ITerminalEnvironment): Promise<ITerminalEnvironment> {
	await Promise.all(Object.entries(env).map(async ([key, value]) => {
		if (typeof value === 'string') {
			try {
				env[key] = await variableResolver(value);
			} catch (e) {
				env[key] = value;
			}
		}
	}));

	return env;
}

export function shouldSetLangEnvVariable(env: IProcessEnvironment, detectLocale: 'auto' | 'off' | 'on'): boolean {
	if (detectLocale === 'on') {
		return true;
	}
	if (detectLocale === 'auto') {
		const lang = env['LANG'];
		return !lang || (lang.search(/\.UTF\-8$/) === -1 && lang.search(/\.utf8$/) === -1 && lang.search(/\.euc.+/) === -1);
	}
	return false; // 'off'
}

export function getLangEnvVariable(locale?: string): string {
	const parts = locale ? locale.split('-') : [];
	const n = parts.length;
	if (n === 0) {
		// Fallback to en_US if the locale is unknown
		return 'en_US.UTF-8';
	}
	if (n === 1) {
		// The local may only contain the language, not the variant, if this is the case guess the
		// variant such that it can be used as a valid $LANG variable. The language variant chosen
		// is the original and/or most prominent with help from
		// https://stackoverflow.com/a/2502675/1156119
		// The list of locales was generated by running `locale -a` on macOS
		const languageVariants: { [key: string]: string } = {
			af: 'ZA',
			am: 'ET',
			be: 'BY',
			bg: 'BG',
			ca: 'ES',
			cs: 'CZ',
			da: 'DK',
			// de: 'AT',
			// de: 'CH',
			de: 'DE',
			el: 'GR',
			// en: 'AU',
			// en: 'CA',
			// en: 'GB',
			// en: 'IE',
			// en: 'NZ',
			en: 'US',
			es: 'ES',
			et: 'EE',
			eu: 'ES',
			fi: 'FI',
			// fr: 'BE',
			// fr: 'CA',
			// fr: 'CH',
			fr: 'FR',
			he: 'IL',
			hr: 'HR',
			hu: 'HU',
			hy: 'AM',
			is: 'IS',
			// it: 'CH',
			it: 'IT',
			ja: 'JP',
			kk: 'KZ',
			ko: 'KR',
			lt: 'LT',
			// nl: 'BE',
			nl: 'NL',
			no: 'NO',
			pl: 'PL',
			pt: 'BR',
			// pt: 'PT',
			ro: 'RO',
			ru: 'RU',
			sk: 'SK',
			sl: 'SI',
			sr: 'YU',
			sv: 'SE',
			tr: 'TR',
			uk: 'UA',
			zh: 'CN',
		};
		if (parts[0] in languageVariants) {
			parts.push(languageVariants[parts[0]]);
		}
	} else {
		// Ensure the variant is uppercase to be a valid $LANG
		parts[1] = parts[1].toUpperCase();
	}
	return parts.join('_') + '.UTF-8';
}

export async function getCwd(
	shell: IShellLaunchConfig,
	userHome: string | undefined,
	variableResolver: VariableResolver | undefined,
	root: URI | undefined,
	customCwd: string | undefined,
	logService?: ILogService
): Promise<string> {
	if (shell.cwd) {
		const unresolved = (typeof shell.cwd === 'object') ? shell.cwd.fsPath : shell.cwd;
		const resolved = await _resolveCwd(unresolved, variableResolver);
		return sanitizeCwd(resolved || unresolved);
	}

	let cwd: string | undefined;

	if (!shell.ignoreConfigurationCwd && customCwd) {
		if (variableResolver) {
			customCwd = await _resolveCwd(customCwd, variableResolver, logService);
		}
		if (customCwd) {
			if (path.isAbsolute(customCwd)) {
				cwd = customCwd;
			} else if (root) {
				cwd = path.join(root.fsPath, customCwd);
			}
		}
	}

	// If there was no custom cwd or it was relative with no workspace
	if (!cwd) {
		cwd = root ? root.fsPath : userHome || '';
	}

	return sanitizeCwd(cwd);
}

async function _resolveCwd(cwd: string, variableResolver: VariableResolver | undefined, logService?: ILogService): Promise<string | undefined> {
	if (variableResolver) {
		try {
			return await variableResolver(cwd);
		} catch (e) {
			logService?.error('Could not resolve terminal cwd', e);
			return undefined;
		}
	}
	return cwd;
}

export type VariableResolver = (str: string) => Promise<string>;

export function createVariableResolver(lastActiveWorkspace: IWorkspaceFolder | undefined, env: IProcessEnvironment, configurationResolverService: IConfigurationResolverService | undefined): VariableResolver | undefined {
	if (!configurationResolverService) {
		return undefined;
	}
	return (str) => configurationResolverService.resolveWithEnvironment(env, lastActiveWorkspace, str);
}

export async function createTerminalEnvironment(
	shellLaunchConfig: IShellLaunchConfig,
	envFromConfig: ITerminalEnvironment | undefined,
	variableResolver: VariableResolver | undefined,
	version: string | undefined,
	detectLocale: 'auto' | 'off' | 'on',
	baseEnv: IProcessEnvironment
): Promise<IProcessEnvironment> {
	// Create a terminal environment based on settings, launch config and permissions
	const env: IProcessEnvironment = {};
	if (shellLaunchConfig.strictEnv) {
		// strictEnv is true, only use the requested env (ignoring null entries)
		mergeNonNullKeys(env, shellLaunchConfig.env);
	} else {
		// Merge process env with the env from config and from shellLaunchConfig
		mergeNonNullKeys(env, baseEnv);

		const allowedEnvFromConfig = { ...envFromConfig };

		// Resolve env vars from config and shell
		if (variableResolver) {
			if (allowedEnvFromConfig) {
				await resolveConfigurationVariables(variableResolver, allowedEnvFromConfig);
			}
			if (shellLaunchConfig.env) {
				await resolveConfigurationVariables(variableResolver, shellLaunchConfig.env);
			}
		}

		// Sanitize the environment, removing any undesirable VS Code and Electron environment
		// variables
		sanitizeProcessEnvironment(env, 'VSCODE_IPC_HOOK_CLI', 'VSCODE_PROXY_URI');

		// Merge config (settings) and ShellLaunchConfig environments
		mergeEnvironments(env, allowedEnvFromConfig);
		mergeEnvironments(env, shellLaunchConfig.env);

		// Adding other env keys necessary to create the process
		addTerminalEnvironmentKeys(env, version, language, detectLocale);
	}
	return env;
}

/**
 * Takes a path and returns the properly escaped path to send to a given shell. On Windows, this
 * included trying to prepare the path for WSL if needed.
 *
 * @param originalPath The path to be escaped and formatted.
 * @param executable The executable off the shellLaunchConfig.
 * @param title The terminal's title.
 * @param shellType The type of shell the path is being sent to.
 * @param backend The backend for the terminal.
 * @param isWindowsFrontend Whether the frontend is Windows, this is only exposed for injection via
 * tests.
 * @returns An escaped version of the path to be execuded in the terminal.
 */
export async function preparePathForShell(resource: string | URI, executable: string | undefined, title: string, shellType: TerminalShellType | undefined, backend: Pick<ITerminalBackend, 'getWslPath'> | undefined, os: OperatingSystem | undefined, isWindowsFrontend: boolean = isWindows): Promise<string> {
	let originalPath: string;
	if (isString(resource)) {
		originalPath = resource;
	} else {
		originalPath = resource.fsPath;
		// Apply backend OS-specific formatting to the path since URI.fsPath uses the frontend's OS
		if (isWindowsFrontend && os !== OperatingSystem.Windows) {
			originalPath = originalPath.replace(/\\/g, '\/');
		} else if (!isWindowsFrontend && os === OperatingSystem.Windows) {
			originalPath = originalPath.replace(/\//g, '\\');
		}
	}

	if (!executable) {
		return originalPath;
	}

	const hasSpace = originalPath.includes(' ');
	const hasParens = originalPath.includes('(') || originalPath.includes(')');

	const pathBasename = path.basename(executable, '.exe');
	const isPowerShell = pathBasename === 'pwsh' ||
		title === 'pwsh' ||
		pathBasename === 'powershell' ||
		title === 'powershell';


	if (isPowerShell && (hasSpace || originalPath.includes('\''))) {
		return `& '${originalPath.replace(/'/g, '\'\'')}'`;
	}

	if (hasParens && isPowerShell) {
		return `& '${originalPath}'`;
	}

	if (os === OperatingSystem.Windows) {
		// 17063 is the build number where wsl path was introduced.
		// Update Windows uriPath to be executed in WSL.
		if (shellType !== undefined) {
			if (shellType === WindowsShellType.GitBash) {
				return escapeNonWindowsPath(originalPath.replace(/\\/g, '/'));
			}
			else if (shellType === WindowsShellType.Wsl) {
				return backend?.getWslPath(originalPath, 'win-to-unix') || originalPath;
			}
			else if (hasSpace) {
				return `"${originalPath}"`;
			}
			return originalPath;
		}
		const lowerExecutable = executable.toLowerCase();
		if (lowerExecutable.includes('wsl') || (lowerExecutable.includes('bash.exe') && !lowerExecutable.toLowerCase().includes('git'))) {
			return backend?.getWslPath(originalPath, 'win-to-unix') || originalPath;
		} else if (hasSpace) {
			return `"${originalPath}"`;
		}
		return originalPath;
	}

	return escapeNonWindowsPath(originalPath);
}

export function getWorkspaceForTerminal(cwd: URI | string | undefined, workspaceContextService: IWorkspaceContextService, historyService: IHistoryService): IWorkspaceFolder | undefined {
	const cwdUri = typeof cwd === 'string' ? URI.parse(cwd) : cwd;
	let workspaceFolder = cwdUri ? workspaceContextService.getWorkspaceFolder(cwdUri) ?? undefined : undefined;
	if (!workspaceFolder) {
		// fallback to last active workspace if cwd is not available or it is not in workspace
		// TOOD: last active workspace is known to be unreliable, we should remove this fallback eventually
		const activeWorkspaceRootUri = historyService.getLastActiveWorkspaceRoot();
		workspaceFolder = activeWorkspaceRootUri ? workspaceContextService.getWorkspaceFolder(activeWorkspaceRootUri) ?? undefined : undefined;
	}
	return workspaceFolder;
}
