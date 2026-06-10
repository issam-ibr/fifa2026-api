/**
 * FIFA World Cup 2026 — Fetch depuis ESPN API (gratuite, sans clé)
 * Récupère tous les matchs + équipes + groupes officiels
 */

require('dotenv').config();
const { PrismaClient } = require('../fifa2026-predictor/node_modules/.pnpm/@prisma+client@5.22.0_prisma@5.22.0/node_modules/@prisma/client');

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world';

// ISO codes pour les drapeaux (ESPN name → ISO)
const NAME_TO_ISO = {
  'Mexico':'mx','South Africa':'za','South Korea':'kr','Korea Republic':'kr','Czechia':'cz','Czech Republic':'cz',
  'United States':'us','USA':'us','Albania':'al','Ukraine':'ua','Panama':'pa',
  'Argentina':'ar','Chile':'cl','Peru':'pe','Australia':'au',
  'France':'fr','Belgium':'be','Morocco':'ma','Croatia':'hr',
  'Brazil':'br','Ecuador':'ec','Japan':'jp','Egypt':'eg',
  'Spain':'es','Serbia':'rs','Turkey':'tr','New Zealand':'nz','Türkiye':'tr',
  'England':'gb-eng','Senegal':'sn','Netherlands':'nl','Slovakia':'sk',
  'Germany':'de','Colombia':'co','Uruguay':'uy','Bolivia':'bo',
  'Portugal':'pt','Iran':'ir','Indonesia':'id','Nigeria':'ng',
  'Canada':'ca','Honduras':'hn','Venezuela':'ve','Ireland':'ie','Republic of Ireland':'ie',
  'Greece':'gr','Scotland':'gb-sct','Poland':'pl','Costa Rica':'cr',
  'Italy':'it','Cameroon':'cm','Switzerland':'ch','Algeria':'dz',
};

// Toutes les dates de matchs FIFA 2026 (phase de groupes: 11 juin - 3 juillet)
function getDates(start, end) {
  const dates = [];
  const cur = new Date(start);
  const last = new Date(end);
  while (cur <= last) {
    dates.push(cur.toISOString().slice(0,10).replace(/-/g,''));
    cur.setDate(cur.getDate() + 1);
  }
  return dates;
}

async function fetchMatchday(date) {
  const url = `${BASE}/scoreboard?dates=${date}&limit=20`;
  const r = await fetch(url);
  const d = await r.json();
  return d.events ?? [];
}

async function fetchTeamDetails(teamId) {
  try {
    const r = await fetch(`${BASE}/teams/${teamId}`);
    const d = await r.json();
    return d.team;
  } catch { return null; }
}

async function main() {
  const prisma = new PrismaClient();

  try {
    console.log('🌍 FIFA World Cup 2026 — Fetch ESPN API');
    console.log('==========================================\n');

    // Récupérer tous les matchs (11 juin → 19 juillet 2026)
    const dates = getDates('2026-06-11', '2026-07-19');
    console.log(`📅 Scan de ${dates.length} jours...`);

    const allEvents = [];
    let daysWithMatches = 0;

    for (const date of dates) {
      const events = await fetchMatchday(date);
      if (events.length > 0) {
        allEvents.push(...events);
        daysWithMatches++;
        process.stdout.write(`  ${date}: ${events.length} matchs\n`);
      }
      // Petite pause pour éviter rate limit
      await new Promise(r => setTimeout(r, 150));
    }

    console.log(`\n✅ ${allEvents.length} matchs trouvés sur ${daysWithMatches} journées\n`);

    if (allEvents.length === 0) {
      console.error('❌ Aucun match trouvé. Vérifiez la connexion Internet.');
      return;
    }

    // ── Extraire équipes et groupes ─────────────────────────────
    const teamsMap = new Map(); // espnId → team data
    const teamGroupMap = new Map(); // espnId → group letter

    for (const event of allEvents) {
      const comp = event.competitions?.[0];
      if (!comp) continue;

      // Extraire le groupe depuis la note de l'événement
      const groupNote = event.notes?.find(n => n.type === 'event')?.headline ?? '';
      const groupMatch = event.name?.match(/Group ([A-L])/i) ??
                         groupNote.match(/Group ([A-L])/i) ??
                         comp.groups?.[0]?.abbreviation?.match(/([A-L])/);
      const groupLetter = groupMatch?.[1]?.toUpperCase() ?? null;

      // Extraire info du round
      const round = event.season?.slug ?? event.seasonType?.name ?? '';

      for (const competitor of comp.competitors ?? []) {
        const t = competitor.team;
        if (!teamsMap.has(t.id)) {
          teamsMap.set(t.id, {
            id:          t.id,
            name:        t.displayName ?? t.name,
            shortName:   t.abbreviation ?? t.shortDisplayName,
            logo:        t.logo,
            flagUrl:     t.flag ?? t.logo,
          });
        }
        if (groupLetter && !teamGroupMap.has(t.id)) {
          teamGroupMap.set(t.id, groupLetter);
        }
      }
    }

    // Essayer de récupérer les groupes depuis le standings ESPN
    console.log('📊 Fetch standings (groupes officiels)...');
    try {
      const sr = await fetch(`${BASE}/standings`);
      const sd = await sr.json();

      for (const group of sd.standings?.entries ?? sd.children ?? []) {
        const gLetter = group.name?.replace('Group ','')?.replace('Groupe ','') ??
                        group.abbreviation ?? '';
        for (const entry of group.standings?.entries ?? group.entries ?? []) {
          const teamId = entry.team?.id;
          if (teamId && gLetter) teamGroupMap.set(teamId, gLetter);
        }
      }
      console.log(`  Groupes récupérés pour ${teamGroupMap.size} équipes`);
    } catch (e) {
      console.log(`  ⚠️  Standings: ${e.message}`);
    }

    // ── Sauvegarder en DB ───────────────────────────────────────
    console.log('\n💾 Mise à jour de la base de données...');

    await prisma.prediction.deleteMany({});
    await prisma.match.deleteMany({});
    await prisma.team.deleteMany({});
    console.log('  Anciennes données supprimées');

    // Insérer équipes
    const dbTeamMap = new Map();
    for (const [espnId, t] of teamsMap) {
      const groupName = teamGroupMap.get(espnId) ?? '?';
      const isoCode   = NAME_TO_ISO[t.name] ?? 'un';

      // Code unique = abréviation ESPN + ID pour éviter les doublons
      const uniqueCode = t.shortName ? `${t.shortName}_${espnId}` : String(espnId);

      const dbTeam = await prisma.team.upsert({
        where:  { code: uniqueCode },
        create: {
          code:       uniqueCode,
          externalId: String(espnId),
          name:       t.name,
          shortName:  t.shortName ?? t.name.slice(0,3).toUpperCase(),
          groupName,
          flagUrl:    t.logo ?? `https://flagcdn.com/w40/${isoCode}.png`,
        },
        update: { name: t.name, groupName, flagUrl: t.logo ?? `https://flagcdn.com/w40/${isoCode}.png` },
      });
      dbTeamMap.set(espnId, dbTeam.id);
    }
    console.log(`  ✅ ${dbTeamMap.size} équipes insérées`);

    // Insérer matchs
    let matchCount = 0;
    const seen = new Set();

    for (const event of allEvents) {
      if (seen.has(event.id)) continue;
      seen.add(event.id);

      const comp = event.competitions?.[0];
      if (!comp || comp.competitors?.length < 2) continue;

      const home = comp.competitors.find(c => c.homeAway === 'home') ?? comp.competitors[0];
      const away = comp.competitors.find(c => c.homeAway === 'away') ?? comp.competitors[1];

      const homeDbId = dbTeamMap.get(home.team.id);
      const awayDbId = dbTeamMap.get(away.team.id);
      if (!homeDbId || !awayDbId) continue;

      // Phase
      const roundName = event.season?.displayName ?? event.name ?? '';
      let phase = 'GROUP_STAGE';
      if (roundName.match(/Round of 32/i))   phase = 'ROUND_OF_32';
      else if (roundName.match(/Round of 16/i)) phase = 'ROUND_OF_16';
      else if (roundName.match(/Quarterfinal/i)) phase = 'QUARTER_FINAL';
      else if (roundName.match(/Semifinal/i))    phase = 'SEMI_FINAL';
      else if (roundName.match(/3rd|Third/i))    phase = 'THIRD_PLACE';
      else if (roundName.match(/Final/i) && !roundName.match(/Semi|Quarter/i)) phase = 'FINAL';

      // Groupe
      const groupMatch = event.name?.match(/Group ([A-L])/i) ?? roundName.match(/Group ([A-L])/i);
      const group = groupMatch?.[1]?.toUpperCase() ?? null;

      // Status
      const statusState = event.status?.type?.state;
      let status = 'SCHEDULED';
      if (statusState === 'in')  status = 'LIVE';
      if (statusState === 'post') status = 'FINISHED';

      // Scores
      const homeScore = status === 'FINISHED' || status === 'LIVE' ? parseInt(home.score) : null;
      const awayScore = status === 'FINISHED' || status === 'LIVE' ? parseInt(away.score) : null;

      await prisma.match.create({
        data: {
          externalId:  String(event.id),
          homeTeamId:  homeDbId,
          awayTeamId:  awayDbId,
          scheduledAt: new Date(event.date),
          status,
          phase,
          group,
          roundName:   roundName || null,
          homeScore:   isNaN(homeScore) ? null : homeScore,
          awayScore:   isNaN(awayScore) ? null : awayScore,
        },
      });
      matchCount++;
    }

    console.log(`  ✅ ${matchCount} matchs insérés`);

    // Afficher les groupes
    const allTeams = await prisma.team.findMany({ orderBy: [{ groupName:'asc' }, { name:'asc' }] });
    const groups = {};
    for (const t of allTeams) {
      if (!groups[t.groupName]) groups[t.groupName] = [];
      groups[t.groupName].push(t.name);
    }

    console.log('\n📋 GROUPES OFFICIELS FIFA 2026:');
    for (const [g, ts] of Object.entries(groups).sort()) {
      console.log(`  Groupe ${g}: ${ts.join(', ')}`);
    }

    console.log(`\n✅ Import terminé: ${dbTeamMap.size} équipes, ${matchCount} matchs`);

  } catch (err) {
    console.error('❌ Erreur:', err.message);
    console.error(err.stack);
  } finally {
    await prisma.$disconnect();
  }
}

main();
