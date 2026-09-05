import mongoose from 'mongoose';

process.loadEnvFile('.env');

const [email, newName] = process.argv.slice(2);

let ok = false;
for (let i = 1; i <= 4 && !ok; i += 1) {
  try {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
    ok = true;
  } catch (err) {
    console.log(`  attempt ${i} failed: ${err.message.slice(0, 60)}`);
    if (i < 4) await new Promise((r) => setTimeout(r, 2000 * i));
  }
}
if (!ok) { console.log('database unreachable'); process.exit(1); }

const db = mongoose.connection.db;
const users = db.collection('users');

const user = await users.findOne({ email });
if (!user) { console.log(`no user with email ${email}`); await mongoose.disconnect(); process.exit(1); }

console.log(`before: name="${user.name}"  email=${user.email}  role=${user.role}`);

await users.updateOne({ _id: user._id }, { $set: { name: newName, updatedAt: new Date() } });

// An account change belongs in the audit trail (PRD §9.6).
await db.collection('auditlogs').insertOne({
  userId: user._id,
  action: 'user.updated',
  targetType: 'User',
  targetId: user._id,
  metadata: { changed: ['name'], reason: 'admin display name change via maintenance script' },
  timestamp: new Date(),
});

const after = await users.findOne({ _id: user._id }, { projection: { name: 1, email: 1, role: 1 } });
console.log(`after : name="${after.name}"  email=${after.email}  role=${after.role}`);

await mongoose.disconnect();
