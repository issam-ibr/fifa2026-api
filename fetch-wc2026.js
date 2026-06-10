/**
 * FIFA World Cup 2026 — Fetch & Seed depuis API-Football
 * Clé gratuite : https://dashboard.api-football.com (100 req/jour)
 */

require('dotenv').config();
const { PrismaClient } = require('../../Users/HP/fifa2026-predictor/node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/@prisma/client');

const API_KEY = process.env.API_FOOTBALL_KEY;
const BASE    = 'https://v3.football.api-sports.io';

// Mapping FIFA code → ISO 2 lettres pour les drapeaux
const FIFA_TO_ISO = {
  'Mexico':'mx','South Africa':'za','Korea Republic':'kr','Czech Republic':'cz',
  'Czechia':'cz','United States':'us','USA':'us','Albania':'al','Ukraine':'ua',
  'Panama':'pa','Argentina':'ar','Chile':'cl','Peru':'pe','Australia':'au',
  'France':'fr','Belgium':'be','Morocco':'ma','Croatia':'hr','Brazil':'br',
  'Ecuador':'ec','Japan':'jp','Egypt':'eg','Spain':'es','Serbia':'rs',
  'Turkey':'tr','New Zealand':'nz','England':'gb-eng','Senegal':'sn',
  'Netherlands':'nl','Slovakia':'sk','Germany':'de','Colombia':'co',
  'Uruguay':'uy','Bolivia':'bo','Portugal':'pt','Iran':'ir','Indonesia':'id',
  'Nigeria':'ng','Canada':'ca','Honduras':'hn','Venezuela':'ve','Ireland':'ie',
  'Greece':'gr','Scotland':'gb-sct','Poland':'pl','Costa Rica':'cr',
  'Italy':'it','Cameroon':'cm','Switzerland':'ch','Algeria':'dz',
};

async function apiFetch(path) {
  const r = await fetch(`${BASE}${path}`, {
    headers: { 'x-apisports-key': API_KEY }
  });
  const data = await r.json();
  if (data.errors && Object.keys(data.errors).length > 0) {
    throw new Error(`API Error: ${JSON.stringify(data.errors)}`);
  }
  return data.response;
}

async function main() {
  if (!API_KEY || API_KEY.length < 10) {
    console.error('❌ API_FOOTBALL_KEY manquante dans .env');
    console.log('\n📋 Pour obtenir une clé gratuite:');
    console.log('   1. Allez sur https://dashboard.api-football.com');
    console.log('   2. Cliquez "Subscribe" → Plan FREE (100 req/jour)');
    console.log('   3. Copiez votre clé API');
    console.log('   4. Ajoutez dans C:\\Users\\HP\\fifa2026-api\\.env:');
    console.log('      API_FOOTBALL_KEY=votre_cle_ici');
    console.log('   5. Relancez: node fetch-wc2026.js');
    process.exit(1);
  }

  const prisma = new PrismaClient();

  try {
    console.log('🔍 Recherche de la Coupe du Monde FIFA 2026...');

    // Chercher le World Cup 2026
    const leagues = await apiFetch('/leagues?name=FIFA+World+Cup&season=2026');
    if (!leagues.length) throw new Error('FIFA World Cup 2026 non trouvé');

    const wc = leagues[0];
    const leagueId = wc.league.id;
    const season   = 2026;
    console.log(`✅ Trouvé: ${wc.league.name} (ID: ${leagueId})`);

    // ── Équipes ────────────────────────────────────────────────────
    console.log('\n📥 Fetch des équipes...');
    const teamsData = await apiFetch(`/teams?league=${leagueId}&season=${season}`);
    console.log(`   ${teamsData.length} équipes trouvées`);

    // ── Standings (groupes) ────────────────────────────────────────
    console.log('📥 Fetch des groupes...');
    let standings = [];
    try {
      standings = await apiFetch(`/standings?league=${leagueId}&season=${season}`);
    } catch (e) {
      console.log('   ⚠️  Standings pas encore disponibles, on les déduit des matchs');
    }

    // Construire map teamId → groupe
    const teamGroupMap = new Map();
    if (standings.length > 0 && standings[0].league?.standings) {
      for (const group of standings[0].league.standings) {
        for (const entry of group) {
          teamGroupMap.set(entry.team.id, entry.group?.replace('Group ','')?.replace('Groupe ','') ?? '?');
        }
      }
    }

    // ── Matches ────────────────────────────────────────────────────
    console.log('📥 Fetch des matchs...');
    const fixturesData = await apiFetch(`/fixtures?league=${leagueId}&season=${season}`);
    console.log(`   ${fixturesData.length} matchs trouvés`);

    // ── Sauvegarder en DB ─────────────────────────────────────────
    console.log('\n💾 Mise à jour de la base de données...');

    // Supprimer les anciennes données
    await prisma.prediction.deleteMany({});
    await prisma.match.deleteMany({});
    await prisma.team.deleteMany({});
    console.log('   Anciennes données supprimées');

    // Insérer les équipes
    const teamDbMap = new Map();
    for (const { team, venue } of teamsData) {
      const isoCode = FIFA_TO_ISO[team.name] ?? team.name.toLowerCase().slice(0,2);
      const group   = teamGroupMap.get(team.id) ?? '?';

      const dbTeam = await prisma.team.upsert({
        where: { code: String(team.id) },
        create: {
          code:       String(team.id),
          externalId: String(team.id),
          name:       team.name,
          shortName:  team.code ?? team.name.slice(0,3).toUpperCase(),
          groupName:  group,
          flagUrl:    team.logo ?? `https://flagcdn.com/w40/${isoCode}.png`,
        },
        update: {
          name:      team.name,
          groupName: group,
          flagUrl:   team.logo ?? `https://flagcdn.com/w40/${isoCode}.png`,
        },
      });

      teamDbMap.set(team.id, dbTeam.id);
    }
    console.log(`   ✅ ${teamDbMap.size} équipes insérées`);

    // Mapper les phases
    const mapPhase = (round) => {
      if (!round) return 'GROUP_STAGE';
      if (round.includes('Group'))          return 'GROUP_STAGE';
      if (round.includes('Round of 32'))    return 'ROUND_OF_32';
      if (round.includes('Round of 16'))    return 'ROUND_OF_16';
      if (round.includes('Quarter'))        return 'QUARTER_FINAL';
      if (round.includes('Semi'))           return 'SEMI_FINAL';
      if (round.includes('3rd') || round.includes('Third')) return 'THIRD_PLACE';
      if (round.includes('Final'))          return 'FINAL';
      return 'GROUP_STAGE';
    };

    const mapStatus = (short) => {
      const map = { 'NS':'SCHEDULED','1H':'LIVE','HT':'LIVE','2H':'LIVE','ET':'LIVE',
        'BT':'LIVE','P':'LIVE','FT':'FINISHED','AET':'FINISHED','PEN':'FINISHED',
        'PST':'POSTPONED','CANC':'CANCELLED','TBD':'SCHEDULED' };
      return map[short] ?? 'SCHEDULED';
    };

    // Insérer les matchs
    let matchOk = 0;
    for (const { fixture, teams, goals, league, score } of fixturesData) {
      const homeDbId = teamDbMap.get(teams.home.id);
      const awayDbId = teamDbMap.get(teams.away.id);
      if (!homeDbId || !awayDbId) continue;

      const group = league.round?.includes('Group')
        ? league.round.split(' - ')[1] ?? league.round.replace('Group Stage - ','')
        : null;

      await prisma.match.create({
        data: {
          externalId:  String(fixture.id),
          homeTeamId:  homeDbId,
          awayTeamId:  awayDbId,
          scheduledAt: new Date(fixture.date),
          status:      mapStatus(fixture.status.short),
          phase:       mapPhase(league.round),
          group,
          roundName:   league.round,
          homeScore:   goals.home,
          awayScore:   goals.away,
        },
      });
      matchOk++;
    }

    console.log(`   ✅ ${matchOk} matchs insérés`);

    // Afficher les groupes
    const dbTeams = await prisma.team.findMany({ orderBy: [{ groupName:'asc' }, { name:'asc' }] });
    const grouped = {};
    for (const t of dbTeams) {
      if (!grouped[t.groupName]) grouped[t.groupName] = [];
      grouped[t.groupName].push(t.name);
    }

    console.log('\n📋 Groupes depuis l\'API:');
    for (const [g, ts] of Object.entries(grouped).sort()) {
      console.log(`   Groupe ${g}: ${ts.join(', ')}`);
    }

    console.log('\n🎉 Terminé ! Données officielles FIFA 2026 importées.');

  } finally {
    await prisma.$disconnect();
  }
}

main().catch(err => {
  console.error('❌ Erreur:', err.message);
  process.exit(1);
});
