/**
 * Correction des groupes depuis ESPN standings officiel
 */
require('dotenv').config();
const { PrismaClient } = require('../fifa2026-predictor/node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/@prisma/client');

const NAME_TO_ISO = {
  'Mexico':'mx','South Africa':'za','South Korea':'kr','Czechia':'cz',
  'Canada':'ca','Bosnia-Herzegovina':'ba','Switzerland':'ch','Qatar':'qa',
  'Brazil':'br','Scotland':'gb-sct','Haiti':'ht','Morocco':'ma',
  'Paraguay':'py','Türkiye':'tr','Australia':'au','United States':'us',
  'Ecuador':'ec','Germany':'de','Ivory Coast':'ci',"Côte d'Ivoire":'ci','Curaçao':'cw',
  'Netherlands':'nl','Sweden':'se','Japan':'jp','Tunisia':'tn',
  'Belgium':'be','Iran':'ir','Egypt':'eg','New Zealand':'nz',
  'Spain':'es','Uruguay':'uy','Saudi Arabia':'sa','Cape Verde':'cv',
  'Norway':'no','France':'fr','Senegal':'sn','Iraq':'iq',
  'Argentina':'ar','Austria':'at','Algeria':'dz','Jordan':'jo',
  'Colombia':'co','Portugal':'pt','Uzbekistan':'uz','Congo DR':'cd',
  'England':'gb-eng','Croatia':'hr','Panama':'pa','Ghana':'gh',
};

async function main() {
  const prisma = new PrismaClient();

  console.log('📊 Fetch groupes officiels ESPN...');
  const r = await fetch('https://site.api.espn.com/apis/v2/sports/soccer/fifa.world/standings');
  const d = await r.json();

  // Map nom ESPN → lettre du groupe
  const nameToGroup = new Map();
  const allGroupTeams = [];

  console.log('\n📋 Groupes officiels FIFA 2026:');
  for (const child of d.children) {
    const letter = child.name.replace('Group ', '');
    const teams  = child.standings.entries.map(e => e.team.displayName);
    console.log(`  Groupe ${letter}: ${teams.join(', ')}`);
    for (const name of teams) {
      nameToGroup.set(name, letter);
      nameToGroup.set(name.toLowerCase(), letter);
    }
    allGroupTeams.push(...teams.map(name => ({ name, group: letter })));
  }

  // Mettre à jour les équipes en DB
  console.log('\n💾 Mise à jour des groupes en base...');
  const dbTeams = await prisma.team.findMany();

  let updated = 0, notFound = [];
  for (const team of dbTeams) {
    // Skip les "TBD" placeholders
    if (team.name.includes('Winner') || team.name.includes('Place') || team.name.includes('Loser')) continue;

    const group = nameToGroup.get(team.name) ?? nameToGroup.get(team.name.toLowerCase());
    const iso   = NAME_TO_ISO[team.name];

    if (group) {
      await prisma.team.update({
        where: { id: team.id },
        data:  {
          groupName: group,
          flagUrl: iso ? `https://flagcdn.com/w40/${iso}.png` : team.flagUrl,
        },
      });
      updated++;
    } else {
      notFound.push(team.name);
    }
  }

  console.log(`✅ ${updated} équipes mises à jour`);
  if (notFound.length) console.log(`⚠️  Non trouvés: ${notFound.join(', ')}`);

  // Mettre à jour les matchs de groupes avec le bon groupe
  console.log('\n📅 Mise à jour des groupes sur les matchs...');
  const allMatches = await prisma.match.findMany({
    where: { phase: 'GROUP_STAGE' },
    include: { homeTeam: true, awayTeam: true },
  });

  let matchUpdated = 0;
  for (const m of allMatches) {
    const group = m.homeTeam.groupName ?? m.awayTeam.groupName;
    if (group && group !== '?') {
      await prisma.match.update({ where: { id: m.id }, data: { group } });
      matchUpdated++;
    }
  }
  console.log(`✅ ${matchUpdated} matchs de groupes mis à jour`);

  // Affichage final
  const finalTeams = await prisma.team.findMany({
    where: { groupName: { not: '?' } },
    orderBy: [{ groupName:'asc' }, { name:'asc' }],
  });
  const grouped = {};
  for (const t of finalTeams) {
    if (t.name.includes('Winner') || t.name.includes('Place')) continue;
    if (!grouped[t.groupName]) grouped[t.groupName] = [];
    grouped[t.groupName].push(t.name);
  }
  console.log('\n✅ Résultat final:');
  for (const [g, ts] of Object.entries(grouped).sort()) {
    console.log(`  Groupe ${g}: ${ts.join(', ')}`);
  }

  await prisma.$disconnect();
}

main().catch(console.error);
