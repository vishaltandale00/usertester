#!/usr/bin/env node
/**
 * usertester CLI entry point
 */
import 'dotenv/config'
import { Command } from 'commander'
import { registerSetup } from './setup.js'
import { registerSpawn } from './spawn.js'
import { registerStatus } from './status.js'
import { registerSend } from './send.js'
import { registerKill } from './kill.js'
import { registerLogs } from './logs.js'
import { registerCleanup } from './cleanup.js'
import { registerProfiles } from './profiles.js'

const program = new Command()

program
  .name('usertester')
  .description('Spawn N AI agents as simulated users to test web app flows')
  .version('0.1.0')

registerSetup(program)
registerSpawn(program)
registerStatus(program)
registerSend(program)
registerKill(program)
registerLogs(program)
registerCleanup(program)
registerProfiles(program)

program.parse()
