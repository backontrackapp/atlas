import fs from 'node:fs'
import path from 'node:path'

const cwd = process.cwd()
const envPath = path.resolve(cwd, '.env')
const envExamplePath = path.resolve(cwd, '.env.example')

if (fs.existsSync(envPath)) {
  console.log(`.env already exists at ${envPath}`)
  process.exit(0)
}

if (!fs.existsSync(envExamplePath)) {
  throw new Error(`Cannot create .env because .env.example is missing at ${envExamplePath}`)
}

fs.copyFileSync(envExamplePath, envPath)
console.log(`Created ${envPath} from ${envExamplePath}`)
console.log('Replace placeholder values before running screenshots/authenticated scripts.')
