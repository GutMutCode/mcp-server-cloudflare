// Shell out to `npx wrangler@latest whoami`
import { exec } from 'child_process'
import { promisify } from 'util'
import {
  AccountInfo,
  fetchInternal,
  FetchResult,
  getAuthTokens,
  isAccessTokenExpired,
  isDirectory,
  refreshToken,
} from './utils/wrangler'
import chalk from 'chalk'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'
import { fileURLToPath } from 'url'
import { createDialog, endSection, logRaw, startSection, updateStatus } from './utils/c3'
import { mcpCloudflareVersion } from './utils/helpers'
import which from 'which'

const __filename = fileURLToPath(import.meta.url)

const execAsync = promisify(exec)

export async function init(accountTag: string | undefined) {
  logRaw(
    createDialog([
      `👋 Welcome to ${chalk.yellow('mcp-server-cloudflare')} v${mcpCloudflareVersion}!`,
      `💁‍♀️ This ${chalk.green("'init'")} process will ensure you're connected to the Cloudflare API`,
      `   and install the Cloudflare MCP Server into Claude, Cline, Windsurf and Cursor (${chalk.blue.underline('https://claude.ai/download')})`,
      `ℹ️ For more information, visit ${chalk.blue.underline('https://github.com/GutMutCode/mcp-server-cloudflare')}`,
      `🧡 Let's get started.`,
    ]),
  )

  startSection(`Checking for existing Wrangler auth info`, `Step 1 of 3`)
  updateStatus(chalk.gray(`If anything goes wrong, try running 'npx wrangler@latest login' manually and retrying.`))

  try {
    getAuthTokens()
  } catch (e: any) {
    updateStatus(`${chalk.underline.red('Warning:')} ${chalk.gray(e.message)}`, false)
    updateStatus(`Running '${chalk.yellow('npx wrangler login')}' and retrying...`, false)

    const { stderr, stdout } = await execAsync('npx wrangler@latest login')
    if (stderr) updateStatus(chalk.gray(stderr))

    getAuthTokens()
  }

  updateStatus(`Wrangler auth info loaded!`)

  if (isAccessTokenExpired()) {
    updateStatus(`Access token expired, refreshing...`, false)
    if (await refreshToken()) {
      updateStatus('Successfully refreshed access token')
    } else {
      throw new Error('Failed to refresh access token')
    }
  }

  endSection('Done')
  startSection(`Fetching account info`, `Step 2 of 3`)

  const { result: accounts } = await fetchInternal<FetchResult<AccountInfo[]>>('/accounts')

  let account: string
  switch (accounts.length) {
    case 0:
      throw new Error(`No accounts found. Run 'wrangler whoami' for more info.`)
    case 1:
      if (accountTag && accountTag !== accounts[0].id) {
        throw new Error(`You don't have access to account ${accountTag}. Leave blank to use ${accounts[0].id}.`)
      }
      account = accounts[0].id
      break
    default:
      if (!accountTag) {
        throw new Error(
          `${chalk.red('Multiple accounts found.')}\nUse ${chalk.yellow('npx @gutmutcode/mcp-server-cloudflare init [account_id]')} to specify which account to use.\nYou have access to:\n${accounts.map((a) => `  • ${a.name} — ${a.id}`).join('\n')}`,
        )
      }
      account = accountTag
      break
  }

  updateStatus(`Using account: ${chalk.yellow(account)}`)
  endSection('Done')

  startSection(`Configuring MCP Clients`, `Step 3 of 3`)

  const configPaths = {
    cline: path.join(
      os.homedir(),
      'Library',
      'Application Support',
      'Code',
      'User',
      'globalStorage',
      'saoudrizwan.claude-dev',
      'settings',
      'cline_mcp_settings.json',
    ),
    claude: path.join(os.homedir(), 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
    windsurf: path.join(os.homedir(), '.codeium', 'windsurf', 'mcp_config.json'),
    cursor: path.join(os.homedir(), '.cursor', 'mcp.json'),
  }

  // Define the valid client names
  type ClientName = 'cline' | 'claude' | 'windsurf' | 'cursor'

  const cloudflareConfig = {
    cline: {
      command: (await which('node')).trim(),
      args: [__filename, 'run', account],
      disabled: false,
      autoApprove: [],
    },
    claude: {
      command: (await which('node')).trim(),
      args: [__filename, 'run', account],
    },
    windsurf: {
      command: (await which('node')).trim(),
      args: [__filename, 'run', account],
    },
    cursor: {
      command: (await which('node')).trim(),
      args: [__filename, 'run', account],
    },
  }

  async function writeConfig(clientName: string, configPath: string) {
    try {
      updateStatus(`Configuring ${chalk.yellow(clientName)}...`)

      const configDir = path.dirname(configPath)
      if (!isDirectory(configDir)) {
        updateStatus(`${chalk.yellow(clientName)} config directory not found at: ${chalk.gray(configDir)}`, false)
        return false
      }

      const existingConfig = fs.existsSync(configPath)
        ? JSON.parse(fs.readFileSync(configPath, 'utf8'))
        : { mcpServers: {} }

      if ('cloudflare' in (existingConfig?.mcpServers || {})) {
        updateStatus(
          `${chalk.green('Note:')} Replacing existing Cloudflare MCP config in ${clientName}:\n${chalk.gray(JSON.stringify(existingConfig.mcpServers.cloudflare))}`,
          false,
        )
      }

      const newConfig = {
        ...existingConfig,
        mcpServers: {
          ...existingConfig.mcpServers,
          cloudflare: cloudflareConfig[clientName as ClientName] || cloudflareConfig.cline, // Type-safe access
        },
      }

      fs.writeFileSync(configPath, JSON.stringify(newConfig, null, 2))
      updateStatus(`Successfully configured ${chalk.yellow(clientName)}!`, false)
      updateStatus(`Config written to: ${chalk.gray(configPath)}`, false)
      return true
    } catch (error: any) {
      updateStatus(`${chalk.red('Error')} configuring ${clientName}: ${error.message}`, false)
      return false
    }
  }

  let successCount = 0
  for (const [clientName, configPath] of Object.entries(configPaths)) {
    if (await writeConfig(clientName, configPath)) {
      successCount++
    }
  }

  if (successCount > 0) {
    updateStatus(chalk.green(`\nSuccessfully configured ${successCount} client(s)!`))
    updateStatus(
      chalk.blue(`Try asking any configured client to "tell me which Workers I have on my account" to get started!`),
    )
  } else {
    updateStatus(chalk.yellow('\nNo clients were configured. You may need to configure them manually.'))
    updateStatus(
      `Manual configuration example:\n${chalk.gray(JSON.stringify({ mcpServers: { cloudflare: cloudflareConfig } }, null, 2))}`,
    )
  }

  endSection('Done')
}
