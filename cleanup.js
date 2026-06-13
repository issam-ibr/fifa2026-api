const { PrismaClient } = require('./node_modules/@prisma/client');
const bcrypt = require('./node_modules/bcryptjs');
const prisma = new PrismaClient();

async function main() {
  console.log('Suppression...');
  await prisma.prediction.deleteMany({});
  await prisma.leagueMember.deleteMany({});
  await prisma.refreshToken.deleteMany({});
  await prisma.userBadge.deleteMany({});
  await prisma.userReward.deleteMany({});
  await prisma.notification.deleteMany({});
  await prisma.ranking.deleteMany({});
  await prisma.auditLog.deleteMany({});
  await prisma.fcmToken.deleteMany({});
  await prisma.oAuthAccount.deleteMany({});
  await prisma.userProfile.deleteMany({});
  await prisma.user.deleteMany({});
  console.log('Tous les utilisateurs supprimes');

  const hash = await bcrypt.hash('Issam@2026!', 12);
  const user = await prisma.user.create({
    data: {
      email: 'issam.ibirri1@gmail.com',
      passwordHash: hash,
      role: 'SUPER_ADMIN',
      emailVerified: new Date(),
      profile: { create: { username: 'issam', firstName: 'Issam', lastName: 'Ibirri', country: 'MA' } }
    },
    include: { profile: true }
  });
  console.log('Utilisateur cree : ' + user.email);
  console.log('Mot de passe     : Issam@2026!');
  console.log('Username         : ' + user.profile.username);
  console.log('Role             : ' + user.role);
}

main().catch(console.error).finally(function() { return prisma.$disconnect(); });
