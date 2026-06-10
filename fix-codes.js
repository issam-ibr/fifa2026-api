require('dotenv').config();
const { PrismaClient } = require('../fifa2026-predictor/node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/@prisma/client');
const prisma = new PrismaClient();
async function main() {
  const teams = await prisma.team.findMany();
  for (const t of teams) {
    const clean = (t.shortName || '').replace(/_\d+$/, '').toUpperCase().slice(0,3);
    await prisma.team.update({ where:{id:t.id}, data:{shortName:clean} });
  }
  console.log('Done: ' + teams.length + ' teams fixed');
}
main().catch(console.error).finally(()=>prisma.$disconnect());
