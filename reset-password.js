require('dotenv').config();
const { PrismaClient } = require('./node_modules/@prisma/client');
const bcrypt = require('./node_modules/bcryptjs');
const prisma = new PrismaClient();

async function main() {
  const email = 'eafoudi@fmps.ma';
  const newPassword = 'Eafoudi@2026!';

  const user = await prisma.user.findUnique({ where: { email }, include: { profile: true } });
  if (!user) { console.log('Utilisateur introuvable : ' + email); return; }

  const hash = await bcrypt.hash(newPassword, 12);
  await prisma.user.update({ where: { email }, data: { passwordHash: hash } });

  console.log('Mot de passe reinitialise !');
  console.log('Email    : ' + user.email);
  console.log('Username : ' + user.profile.username);
  console.log('Nouveau MDP : ' + newPassword);
}

main().catch(console.error).finally(function() { return prisma.$disconnect(); });
