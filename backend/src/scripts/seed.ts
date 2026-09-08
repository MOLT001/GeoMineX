/**
 * Bootstrap the first admin and the subsidiary list.
 *
 * Accounts are invite-only (PRD §2), and issuing an invite requires an admin —
 * so the very first admin has to be created out-of-band. This script is that
 * one exception. It is idempotent: re-running it will not duplicate anything.
 *
 *   npm run seed -- --email admin@example.gov.in --name "System Admin"
 */
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { logger } from '../utils/logger.js';
import { User } from '../modules/users/user.model.js';
import { Subsidiary } from '../modules/subsidiaries/subsidiary.model.js';
import { ReportTemplate } from '../modules/reports/reportTemplate.model.js';
import { recordAudit } from '../modules/audit/audit.service.js';

/**
 * Coal India's eight subsidiaries. Adjust to the deployment's actual scope.
 *
 * The eight are the seven coal-producing companies below plus CMPDI. North
 * Eastern Coalfields is deliberately absent: it is a unit administered directly
 * by CIL, not a subsidiary, and listing it here previously displaced CMPDI —
 * the very organisation this system is built for.
 */
const DEFAULT_SUBSIDIARIES = [
  { code: 'ECL', name: 'Eastern Coalfields Limited' },
  { code: 'BCCL', name: 'Bharat Coking Coal Limited' },
  { code: 'CCL', name: 'Central Coalfields Limited' },
  { code: 'NCL', name: 'Northern Coalfields Limited' },
  { code: 'WCL', name: 'Western Coalfields Limited' },
  { code: 'SECL', name: 'South Eastern Coalfields Limited' },
  { code: 'MCL', name: 'Mahanadi Coalfields Limited' },
  { code: 'CMPDI', name: 'Central Mine Planning & Design Institute Limited' },
];

export interface SeedResult {
  subsidiariesCreated: number;
  templatesCreated: number;
  adminCreated: boolean;
}

/**
 * A starter template so report drafting is usable immediately.
 * `{{Field Name}}` placeholders resolve against extracted document fields;
 * an unmatched one is left visibly unresolved for the human editor.
 */
const DEFAULT_TEMPLATE = {
  name: 'Quarterly Production Summary',
  description: 'Starter template. Placeholders resolve from extracted document fields.',
  sections: [
    {
      heading: 'Production Summary',
      body: 'Reported output for the period was {{Production Tonnes}} tonnes at grade {{Grade}}.',
    },
    {
      heading: 'Observations',
      body: 'Replace this section with narrative commentary before publishing.',
    },
  ],
};

/**
 * The seeding itself, separated from the CLI wrapper so it can be tested
 * against a real database rather than only exercised by hand.
 *
 * Assumes an open connection; idempotent on repeat runs.
 */
export async function runSeed(email: string, name: string): Promise<SeedResult> {
  let subsidiariesCreated = 0;

  for (const entry of DEFAULT_SUBSIDIARIES) {
    const existing = await Subsidiary.findOne({ code: entry.code, isDeleted: false });
    if (!existing) {
      await Subsidiary.create(entry);
      subsidiariesCreated += 1;
    }
  }

  let templatesCreated = 0;
  const existingTemplate = await ReportTemplate.findOne({ name: DEFAULT_TEMPLATE.name, isDeleted: false });
  if (!existingTemplate) {
    await ReportTemplate.create({ ...DEFAULT_TEMPLATE, subsidiaryScope: [], version: 1 });
    templatesCreated = 1;
  }

  const existingAdmin = await User.findOne({ email, isDeleted: false });
  if (existingAdmin) {
    return { subsidiariesCreated, templatesCreated, adminCreated: false };
  }

  const admin = await User.create({
    email,
    name,
    role: 'admin',
    subsidiaryAccess: [], // Admin is unscoped by definition.
    isActive: true,
    isInvitePending: false,
  });

  await recordAudit({
    action: 'user.created',
    targetType: 'User',
    targetId: String(admin._id),
    metadata: { role: 'admin', via: 'seed-script' },
  });

  return { subsidiariesCreated, templatesCreated, adminCreated: true };
}

function readArg(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index !== -1 ? process.argv[index + 1] : undefined;
}

async function main(): Promise<void> {
  const email = readArg('--email')?.toLowerCase().trim();
  const name = readArg('--name') ?? 'System Administrator';

  if (!email) {
    logger.error('Usage: npm run seed -- --email <address> [--name "Full Name"]');
    process.exitCode = 1;
    return;
  }

  await connectDatabase();
  const result = await runSeed(email, name);

  logger.info(
    result.adminCreated
      ? `Created admin ${email}, ${result.subsidiariesCreated} subsidiaries and ${result.templatesCreated} report template(s). Sign in with POST /api/v1/auth/request-code.`
      : `User ${email} already exists; created ${result.subsidiariesCreated} subsidiaries.`,
  );

  await disconnectDatabase();
}

// Only run the CLI when executed directly, so importing this module in a test
// does not connect to a database or exit the process.
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replaceAll('\\', '/').split('/').pop() ?? '')) {
  main().catch((err: unknown) => {
    logger.error('Seed failed', { message: err instanceof Error ? err.message : String(err) });
    process.exit(1);
  });
}
