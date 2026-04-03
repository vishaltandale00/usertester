/**
 * usertester profiles — view/manage profile meta-learning data
 */
import type { Command } from 'commander'
import path from 'node:path'
import fs from 'node:fs'
import { DEFAULT_CONFIG } from '../types.js'
import type { ProfileFacts } from '../types.js'

export function registerProfiles(program: Command): void {
  const profiles = program
    .command('profiles')
    .description('Manage profile meta-learning data')

  profiles
    .command('list')
    .description('List all learned profiles')
    .action(() => {
      const config = { ...DEFAULT_CONFIG }
      const profilesDir = path.join(config.results_dir, 'profiles')

      try {
        const files = fs.readdirSync(profilesDir).filter(f => f.endsWith('.json'))
        if (files.length === 0) {
          console.log('No profiles yet. Profiles are created after completed sessions.')
          return
        }

        for (const file of files) {
          const profile = JSON.parse(
            fs.readFileSync(path.join(profilesDir, file), 'utf-8'),
          ) as ProfileFacts
          console.log(`\n${file.replace('.json', '')}`)
          console.log(`  URL:      ${profile.url}`)
          console.log(`  Scenario: ${profile.scenario}`)
          console.log(`  Runs:     ${profile.runCount}`)
          console.log(`  Hints:    ${profile.harnessHints.length}`)
          for (const hint of profile.harnessHints.slice(0, 3)) {
            console.log(`    [${(hint.confidence * 100).toFixed(0)}%] ${hint.observation}`)
          }
        }
      } catch {
        console.log('No profiles directory found.')
      }
    })

  profiles
    .command('show <profile-key>')
    .description('Show full profile details')
    .action((profileKey) => {
      const config = { ...DEFAULT_CONFIG }
      const profilePath = path.join(config.results_dir, 'profiles', `${profileKey}.json`)

      try {
        const profile = JSON.parse(fs.readFileSync(profilePath, 'utf-8')) as ProfileFacts
        console.log(JSON.stringify(profile, null, 2))
      } catch {
        console.error(`Profile not found: ${profileKey}`)
        process.exit(1)
      }
    })

  profiles
    .command('delete <profile-key>')
    .description('Delete a profile')
    .action((profileKey) => {
      const config = { ...DEFAULT_CONFIG }
      const profilePath = path.join(config.results_dir, 'profiles', `${profileKey}.json`)

      try {
        fs.unlinkSync(profilePath)
        console.log(`Deleted profile: ${profileKey}`)
      } catch {
        console.error(`Profile not found: ${profileKey}`)
        process.exit(1)
      }
    })
}
