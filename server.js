require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

// Prisma — fonctionne en local ET en production
let PrismaClient;
try {
  // Production (Render) : Prisma installé via package.json
  PrismaClient = require('@prisma/client').PrismaClient;
} catch {
  // Développement local : Prisma du monorepo
  PrismaClient = require('C:\\Users\\HP\\fifa2026-predictor\\node_modules\\.pnpm\\@prisma+client@5.22.0_prisma@5.22.0\\node_modules\\@prisma\\client').PrismaClient;
}

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3001;
const JWT_SECRET = process.env.JWT_SECRET || 'dev_jwt_secret_minimum_32_characters_long_ok';
const JWT_REFRESH = process.env.JWT_REFRESH_SECRET || 'dev_refresh_secret_minimum_32_chars_ok';

// ══════════════════════════════════════════════════════════════════
// ── MOTEUR DE CALCUL DES POINTS ───────────────────────────────────
// ══════════════════════════════════════════════════════════════════

/**
 * Calcule et attribue les points pour un match terminé.
 * Appelé automatiquement dès qu'un match passe en status FINISHED.
 *
 * Règles :
 *  - Score exact                     → +5 pts
 *  - Bon vainqueur (mauvais score)   → +3 pts
 *  - Bon écart de buts               → +2 pts
 *  - Mode 1X2 correct                → +2 pts
 *  - Bonus anticipation (>24h avant) → +1 pt
 *  - Score exact bonus parfait       → +5 pts supplémentaires
 */
async function processMatchPoints(matchId) {
  const match = await prisma.match.findUnique({ where: { id: matchId } });
  if (!match || match.status !== 'FINISHED' || match.homeScore === null) return 0;

  // Récupérer tous les pronostics EN ATTENTE pour ce match
  const predictions = await prisma.prediction.findMany({
    where: { matchId, result: 'PENDING' },
  });

  if (predictions.length === 0) return 0;

  // Scores réels
  const realHome   = match.homeScore;
  const realAway   = match.awayScore;
  const realDiff   = realHome - realAway;
  const realWinner = realHome > realAway ? 'HOME' : realAway > realHome ? 'AWAY' : 'DRAW';

  let processed = 0;

  for (const pred of predictions) {
    const predHome   = pred.homeScore;
    const predAway   = pred.awayScore;
    const predDiff   = predHome - predAway;
    const predWinner = predHome > predAway ? 'HOME' : predAway > predHome ? 'AWAY' : 'DRAW';

    let points = 0;
    let result = 'INCORRECT';
    let bonusPerfect = false;

    // ── Cas 1 : Score exact ────────────────────────────────────────
    if (predHome === realHome && predAway === realAway) {
      result = 'EXACT_SCORE';
      points = 5;
      bonusPerfect = true;  // +5 bonus en plus
      points += 5;          // Total : 10 pts de base
    }
    // ── Cas 2 : Bon écart (même différence) mais pas score exact ──
    else if (predDiff === realDiff && predWinner === realWinner) {
      result = 'CORRECT_GOAL_DIFF';
      points = 2;
    }
    // ── Cas 3 : Bon vainqueur (mauvais score, mauvais écart) ──────
    else if (predWinner === realWinner) {
      result = 'CORRECT_WINNER';
      points = 3;
    }
    // ── Cas 4 : Tout faux ────────────────────────────────────────
    else {
      result = 'INCORRECT';
      points = 0;
    }

    // ── Bonus anticipation (+1 si pronostiqué >24h avant) ─────────
    if (points > 0 && pred.bonusEarly) points += 1;

    // ── Mettre à jour le pronostic ─────────────────────────────────
    await prisma.prediction.update({
      where: { id: pred.id },
      data: {
        result,
        pointsEarned: points,
        bonusPerfect,
        isLockedIn:   true,
        processedAt:  new Date(),
      },
    });

    // ── Mettre à jour le profil utilisateur (totaux) ───────────────
    await prisma.userProfile.update({
      where: { userId: pred.userId },
      data: {
        totalPoints:        { increment: points },
        totalPredictions:   { increment: 1 },
        correctPredictions: { increment: (result !== 'INCORRECT') ? 1 : 0 },
        exactScores:        { increment: (result === 'EXACT_SCORE') ? 1 : 0 },
      },
    });

    processed++;
  }

  // Verrouiller TOUS les pronostics du match (même ceux déjà calculés)
  await prisma.prediction.updateMany({
    where: { matchId },
    data: { isLockedIn: true },
  });

  console.log(`✅ Match ${matchId}: ${processed} pronostics calculés`);
  return processed;
}

/**
 * Sync les résultats depuis ESPN et déclenche le calcul des points.
 * Appelé depuis le cron (toutes les 5 min pendant le Mondial) OU manuellement.
 */
async function syncResultsAndCalculate() {
  const startTime = Date.now();
  console.log('🔄 Sync ESPN + calcul des points...');

  try {
    // 1. Récupérer les matchs terminés DEPUIS ESPN
    const today    = new Date().toISOString().slice(0,10).replace(/-/g,'');
    const yesterday = new Date(Date.now()-86400000).toISOString().slice(0,10).replace(/-/g,'');

    let espnMatches = [];
    for (const date of [yesterday, today]) {
      const r = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard?dates=${date}`);
      const d = await r.json();
      espnMatches.push(...(d.events ?? []));
    }

    let updated = 0, calculated = 0;

    for (const event of espnMatches) {
      const comp   = event.competitions?.[0];
      const status = event.status?.type?.state; // 'post' = terminé

      if (!comp) continue;

      // Trouver le match en DB via externalId
      const dbMatch = await prisma.match.findFirst({
        where: { externalId: String(event.id) },
      });
      if (!dbMatch) continue;

      // Récupérer les scores
      const home = comp.competitors?.find(c => c.homeAway === 'home');
      const away = comp.competitors?.find(c => c.homeAway === 'away');
      const homeScore = parseInt(home?.score ?? '0');
      const awayScore = parseInt(away?.score ?? '0');

      // Mapping status ESPN → notre status
      const newStatus = status === 'post' ? 'FINISHED' : status === 'in' ? 'LIVE' : 'SCHEDULED';

      // Détecter si le match VIENT de se terminer (était pas FINISHED avant)
      const justFinished = newStatus === 'FINISHED' && dbMatch.status !== 'FINISHED';

      // Mettre à jour le match en DB
      if (dbMatch.status !== newStatus || dbMatch.homeScore !== homeScore) {
        await prisma.match.update({
          where: { id: dbMatch.id },
          data: {
            status:    newStatus,
            homeScore: !isNaN(homeScore) ? homeScore : null,
            awayScore: !isNaN(awayScore) ? awayScore : null,
          },
        });
        updated++;
      }

      // 🎯 DÉCLENCHER LE CALCUL si le match vient de se terminer
      if (justFinished && !isNaN(homeScore)) {
        const count = await processMatchPoints(dbMatch.id);
        calculated += count;
        console.log(`  🏁 ${dbMatch.id}: FINISHED ${homeScore}-${awayScore} → ${count} pronostics calculés`);
      }

      // Verrouiller les pronostics si le match a commencé (LIVE)
      if (newStatus === 'LIVE' && dbMatch.status === 'SCHEDULED') {
        await prisma.prediction.updateMany({
          where: { matchId: dbMatch.id },
          data: { isLockedIn: true },
        });
        console.log(`  🔒 Match ${dbMatch.id}: pronostics verrouillés (LIVE)`);
      }

      // ⏰ Verrouiller 5 min avant le coup d'envoi (même si pas encore LIVE sur ESPN)
      if (newStatus === 'SCHEDULED' && dbMatch.status === 'SCHEDULED') {
        const minsLeft = (new Date(dbMatch.scheduledAt).getTime() - Date.now()) / 60_000;
        if (minsLeft <= LOCK_MINUTES && minsLeft > -10) {
          await prisma.prediction.updateMany({
            where: { matchId: dbMatch.id, isLockedIn: false },
            data: { isLockedIn: true },
          });
          // Mettre à jour le match pour ne pas re-déclencher
          await prisma.match.update({
            where: { id: dbMatch.id },
            data: { status: 'SCHEDULED' }, // reste SCHEDULED mais pronostics verrouillés
          });
          console.log(`  ⏰ Match ${dbMatch.id}: pronostics verrouillés (J-${Math.ceil(minsLeft)}min)`);
        }
      }
    }

    const duration = Date.now() - startTime;
    console.log(`✅ Sync terminée en ${duration}ms — ${updated} matchs maj, ${calculated} pronostics calculés`);
    return { updated, calculated, duration };

  } catch (err) {
    console.error('❌ Sync error:', err.message);
    return { error: err.message };
  }
}

// ── CRON : Sync automatique toutes les 5 minutes ──────────────────
let syncInterval = null;

function startCron() {
  console.log('⏰ Cron démarré (sync toutes les 5 minutes)');
  syncInterval = setInterval(async () => {
    await syncResultsAndCalculate();
  }, 5 * 60 * 1000); // 5 minutes
}

// Lancer le cron au démarrage du serveur
startCron();

const ALLOWED_ORIGINS = [
  'http://localhost:3000',
  'http://127.0.0.1:3000',
  process.env.CLIENT_URL,                     // Firebase Hosting URL
  'https://ibirri.com',
  'https://www.ibirri.com',
  'https://fifa2026-predictor.web.app',
  'https://fifa2026-predictor-b4792.web.app',
  'https://fifa2026-predictor-b4792.firebaseapp.com',
  'https://fifa2026-predictor.firebaseapp.com',
].filter(Boolean);

app.use(cors({ origin: ALLOWED_ORIGINS, credentials: true }));
app.use(express.json());

function auth(req, res, next) {
  const h = req.headers.authorization;
  if (!h?.startsWith('Bearer ')) return res.status(401).json({ message: 'Non autorisé' });
  try { req.user = jwt.verify(h.slice(7), JWT_SECRET); next(); }
  catch { res.status(401).json({ message: 'Token invalide' }); }
}

function tokens(userId, email, role) {
  return {
    accessToken: jwt.sign({ sub: userId, email, role }, JWT_SECRET, { expiresIn: '15m' }),
    refreshToken: jwt.sign({ sub: userId }, JWT_REFRESH, { expiresIn: '7d' }),
  };
}

// ── Health ────────────────────────────────────────────────────────
app.get('/api/v1/health', (_, res) => res.json({ status: 'ok' }));

// ── Register ──────────────────────────────────────────────────────
app.post('/api/v1/auth/register', async (req, res) => {
  try {
    const { email, password, username, firstName, lastName, country } = req.body;
    if (!email || !password || !username)
      return res.status(400).json({ message: 'email, password et username requis' });

    if (await prisma.user.findUnique({ where: { email } }))
      return res.status(409).json({ message: 'Email déjà utilisé' });
    if (await prisma.userProfile.findUnique({ where: { username } }))
      return res.status(409).json({ message: 'Pseudo déjà pris' });

    const passwordHash = await bcrypt.hash(password, 12);
    const user = await prisma.user.create({
      data: { email, passwordHash, emailVerified: new Date(),
        profile: { create: { username, firstName: firstName || null, lastName: lastName || null, country: country || null } }
      },
      include: { profile: true },
    });

    const tk = tokens(user.id, user.email, user.role);
    const exp = new Date(); exp.setDate(exp.getDate() + 7);
    await prisma.refreshToken.create({ data: { token: tk.refreshToken, userId: user.id, expiresAt: exp } });

    const { passwordHash: _, twoFactorSecret: __, ...safe } = user;
    res.status(201).json({ user: safe, ...tk });
  } catch (e) { console.error(e); res.status(500).json({ message: e.message }); }
});

// ── Login ─────────────────────────────────────────────────────────
app.post('/api/v1/auth/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ message: 'Champs requis' });

    const user = await prisma.user.findUnique({ where: { email }, include: { profile: true } });
    if (!user?.passwordHash) return res.status(401).json({ message: 'Identifiants incorrects' });
    if (user.isBanned) return res.status(403).json({ message: `Compte banni` });

    if (!await bcrypt.compare(password, user.passwordHash))
      return res.status(401).json({ message: 'Identifiants incorrects' });

    await prisma.user.update({ where: { id: user.id }, data: { lastLoginAt: new Date() } });

    const tk = tokens(user.id, user.email, user.role);
    const exp = new Date(); exp.setDate(exp.getDate() + 7);
    await prisma.refreshToken.create({ data: { token: tk.refreshToken, userId: user.id, expiresAt: exp } });

    const { passwordHash: _, twoFactorSecret: __, ...safe } = user;
    res.json({ user: safe, ...tk });
  } catch (e) { console.error(e); res.status(500).json({ message: e.message }); }
});

// ── Logout ────────────────────────────────────────────────────────
app.post('/api/v1/auth/logout', async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) await prisma.refreshToken.deleteMany({ where: { token: refreshToken } }).catch(() => {});
  res.json({ message: 'Déconnecté' });
});

// ── Refresh ───────────────────────────────────────────────────────
app.post('/api/v1/auth/refresh', async (req, res) => {
  try {
    const stored = await prisma.refreshToken.findUnique({ where: { token: req.body.refreshToken }, include: { user: true } });
    if (!stored || stored.expiresAt < new Date()) return res.status(401).json({ message: 'Token expiré' });
    const tk = tokens(stored.user.id, stored.user.email, stored.user.role);
    await prisma.refreshToken.delete({ where: { id: stored.id } });
    const exp = new Date(); exp.setDate(exp.getDate() + 7);
    await prisma.refreshToken.create({ data: { token: tk.refreshToken, userId: stored.user.id, expiresAt: exp } });
    res.json(tk);
  } catch { res.status(401).json({ message: 'Token invalide' }); }
});

// ── Me ────────────────────────────────────────────────────────────
app.get('/api/v1/users/me', auth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({
      where: { id: req.user.sub },
      include: { profile: true },
    });
    if (!user) return res.status(404).json({ message: 'Introuvable' });
    const { passwordHash: _, twoFactorSecret: __, ...safe } = user;
    res.json(safe);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── Update profile ────────────────────────────────────────────────
app.patch('/api/v1/users/me', auth, async (req, res) => {
  try {
    const { firstName, lastName, country } = req.body;
    await prisma.userProfile.update({
      where: { userId: req.user.sub },
      data: {
        ...(firstName !== undefined && { firstName: firstName || null }),
        ...(lastName  !== undefined && { lastName:  lastName  || null }),
        ...(country   !== undefined && { country:   country   || null }),
      },
    });
    res.json({ message: 'Profil mis à jour' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── Change password ────────────────────────────────────────────────
app.patch('/api/v1/users/me/password', auth, async (req, res) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword) return res.status(400).json({ message: 'Champs requis' });
    if (newPassword.length < 8) return res.status(400).json({ message: 'Minimum 8 caractères' });
    if (!/[A-Z]/.test(newPassword)) return res.status(400).json({ message: 'Au moins une majuscule' });
    if (!/[0-9]/.test(newPassword)) return res.status(400).json({ message: 'Au moins un chiffre' });

    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!user?.passwordHash) return res.status(400).json({ message: 'Compte sans mot de passe (OAuth)' });

    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) return res.status(401).json({ message: 'Mot de passe actuel incorrect' });

    const newHash = await bcrypt.hash(newPassword, 12);
    await prisma.user.update({ where: { id: req.user.sub }, data: { passwordHash: newHash } });

    // Invalider tous les refresh tokens (sécurité)
    await prisma.refreshToken.deleteMany({ where: { userId: req.user.sub } });

    res.json({ message: 'Mot de passe modifié avec succès' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── Me stats ──────────────────────────────────────────────────────
app.get('/api/v1/users/me/stats', auth, async (req, res) => {
  const p = await prisma.userProfile.findUnique({ where: { userId: req.user.sub } });
  res.json({
    totalPoints: p?.totalPoints ?? 0,
    totalPredictions: p?.totalPredictions ?? 0,
    correctPredictions: p?.correctPredictions ?? 0,
    exactScores: p?.exactScores ?? 0,
    successRate: p?.totalPredictions > 0 ? Math.round((p.correctPredictions / p.totalPredictions) * 100) : 0,
    globalRank: null,
  });
});

// ── Matches ───────────────────────────────────────────────────────
app.get('/api/v1/matches', async (req, res) => {
  try {
    const { status, limit = 20, page = 1 } = req.query;
    const where = status ? { status } : {};
    const [matches, total] = await Promise.all([
      prisma.match.findMany({
        where,
        include: { homeTeam: true, awayTeam: true, stadium: true },
        orderBy: { scheduledAt: 'asc' },
        skip: (Number(page) - 1) * Number(limit),
        take: Number(limit),
      }),
      prisma.match.count({ where }),
    ]);
    res.json({ matches, total, page: Number(page), limit: Number(limit) });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── Predictions ───────────────────────────────────────────────────
app.get('/api/v1/predictions', auth, async (req, res) => {
  const predictions = await prisma.prediction.findMany({
    where: { userId: req.user.sub },
    include: { match: { include: { homeTeam: true, awayTeam: true } } },
    orderBy: { match: { scheduledAt: 'asc' } },
  });
  res.json({ predictions });
});

const LOCK_MINUTES = 5; // Fermeture des pronostics X minutes avant le coup d'envoi

app.post('/api/v1/predictions', auth, async (req, res) => {
  try {
    const { matchId, homeScore, awayScore, predictionType = 'SCORE', winner } = req.body;
    const match = await prisma.match.findUnique({ where: { id: matchId } });
    if (!match) return res.status(404).json({ message: 'Match introuvable' });

    // ── Vérifications de verrouillage ─────────────────────────────
    // 1. Match déjà commencé ou terminé
    if (match.status !== 'SCHEDULED') {
      return res.status(403).json({ message: 'Ce match a déjà commencé, les pronostics sont fermés.' });
    }

    // 2. Pronostic déjà verrouillé manuellement
    const existing = await prisma.prediction.findUnique({
      where: { userId_matchId: { userId: req.user.sub, matchId } },
    });
    if (existing?.isLockedIn) {
      return res.status(403).json({ message: 'Ton pronostic est verrouillé pour ce match.' });
    }

    // 3. ⏰ FERMETURE 5 MIN AVANT LE COUP D'ENVOI
    const minutesUntilKickoff = (new Date(match.scheduledAt).getTime() - Date.now()) / 60_000;
    if (minutesUntilKickoff <= LOCK_MINUTES) {
      const mins = Math.max(0, Math.ceil(-minutesUntilKickoff));
      if (minutesUntilKickoff <= 0) {
        return res.status(403).json({
          message: `Les pronostics sont fermés. Ce match a commencé il y a ${mins} minute(s).`,
          locked: true,
        });
      }
      return res.status(403).json({
        message: `Les pronostics ferment ${LOCK_MINUTES} minutes avant le coup d'envoi. Plus que ${Math.ceil(minutesUntilKickoff)} min !`,
        locked: true,
        minutesLeft: Math.ceil(minutesUntilKickoff),
      });
    }

    // ── Bonus anticipation (>24h avant) ───────────────────────────
    const bonusEarly = minutesUntilKickoff > (24 * 60);

    // Stocker predictionType et winnerChoice en DB
    const pred = await prisma.prediction.upsert({
      where: { userId_matchId: { userId: req.user.sub, matchId } },
      create: {
        userId: req.user.sub, matchId,
        homeScore: +homeScore, awayScore: +awayScore,
        bonusEarly,
        predictionType: predictionType || 'SCORE',
        winnerChoice:   winner || null,
      },
      update: {
        homeScore: +homeScore, awayScore: +awayScore, bonusEarly,
        predictionType: predictionType || 'SCORE',
        winnerChoice:   winner || null,
      },
    });

    res.json(pred);
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── Rankings ──────────────────────────────────────────────────────
app.get('/api/v1/rankings', async (req, res) => {
  const { page = 1, limit = 50 } = req.query;
  const [profiles, total] = await Promise.all([
    prisma.userProfile.findMany({
      orderBy: [{ totalPoints: 'desc' }, { exactScores: 'desc' }],
      include: { user: { select: { id: true, role: true } } },
      skip: (Number(page) - 1) * Number(limit),
      take: Number(limit),
    }),
    prisma.userProfile.count(),
  ]);
  res.json({
    rankings: profiles.map((p, i) => ({
      rank: (Number(page) - 1) * Number(limit) + i + 1,
      userId: p.userId,
      points: p.totalPoints,
      exactScores: p.exactScores,
      totalPredictions: p.totalPredictions,
      user: { id: p.userId, role: p.user.role, profile: { username: p.username, avatarUrl: p.avatarUrl, country: p.country } },
    })),
    total, page: Number(page), totalPages: Math.ceil(total / Number(limit)),
  });
});

// ── Predictions d'un match (tous les utilisateurs) ────────────────
app.get('/api/v1/matches/:id/predictions', auth, async (req, res) => {
  try {
    const match = await prisma.match.findUnique({
      where: { id: req.params.id },
      include: { homeTeam: true, awayTeam: true },
    });
    if (!match) return res.status(404).json({ message: 'Match introuvable' });

    // Visible seulement si match LIVE ou FINISHED
    if (match.status === 'SCHEDULED') {
      return res.status(403).json({ message: 'Les pronostics sont visibles seulement apres le coup d\'envoi' });
    }

    const predictions = await prisma.prediction.findMany({
      where: { matchId: req.params.id },
      include: {
        user: {
          include: { profile: { select: { username: true, avatarUrl: true, country: true } } },
        },
      },
      orderBy: { pointsEarned: 'desc' },
    });

    res.json({
      match,
      predictions: predictions.map(p => ({
        userId:         p.userId,
        username:       p.user.profile?.username ?? '?',
        avatarUrl:      p.user.profile?.avatarUrl,
        country:        p.user.profile?.country,
        homeScore:      p.homeScore,
        awayScore:      p.awayScore,
        predictionType: p.predictionType,
        winnerChoice:   p.winnerChoice,
        result:         p.result,
        pointsEarned:   p.pointsEarned,
        bonusEarly:     p.bonusEarly,
      })),
      stats: {
        total:       predictions.length,
        homeWin:     predictions.filter(p => p.homeScore > p.awayScore || p.winnerChoice === 'HOME').length,
        draw:        predictions.filter(p => p.homeScore === p.awayScore || p.winnerChoice === 'DRAW').length,
        awayWin:     predictions.filter(p => p.homeScore < p.awayScore || p.winnerChoice === 'AWAY').length,
        exactScores: predictions.filter(p => p.result === 'EXACT_SCORE').length,
      },
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── Teams ─────────────────────────────────────────────────────────
app.get('/api/v1/teams', async (_, res) => {
  res.json({ teams: await prisma.team.findMany({ orderBy: { name: 'asc' } }) });
});

// ══════════════════════════════════════════════════════════════════
// ── LEAGUES ───────────────────────────────────────────────────────
// ══════════════════════════════════════════════════════════════════

function generateCode(len = 8) {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let code = '';
  for (let i = 0; i < len; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').substring(0, 50)
    + '-' + Date.now().toString(36);
}

// Créer une ligue
app.post('/api/v1/leagues', auth, async (req, res) => {
  try {
    const { name, description, isPrivate = true } = req.body;
    if (!name?.trim()) return res.status(400).json({ message: 'Nom de la ligue requis' });

    const inviteCode = generateCode(8);
    const slug = slugify(name);

    const league = await prisma.league.create({
      data: {
        creatorId:   req.user.sub,
        name:        name.trim(),
        slug,
        description: description?.trim() || null,
        visibility:  isPrivate ? 'PRIVATE' : 'PUBLIC',
        inviteCode,
        members: {
          create: { userId: req.user.sub, isAdmin: true },
        },
        chat: { create: {} },
      },
      include: {
        members: { include: { user: { include: { profile: true } } } },
        _count: { select: { members: true } },
      },
    });

    res.status(201).json(league);
  } catch (e) { console.error(e); res.status(500).json({ message: e.message }); }
});

// Mes ligues
app.get('/api/v1/leagues', auth, async (req, res) => {
  try {
    const memberships = await prisma.leagueMember.findMany({
      where: { userId: req.user.sub },
      include: {
        league: {
          include: {
            creator: { include: { profile: true } },
            _count: { select: { members: true } },
          },
        },
      },
      orderBy: { joinedAt: 'desc' },
    });

    const leagues = memberships.map(m => ({
      ...m.league,
      isAdmin: m.isAdmin,
      joinedAt: m.joinedAt,
    }));

    res.json({ leagues });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Rejoindre une ligue via code
app.post('/api/v1/leagues/join', auth, async (req, res) => {
  try {
    const { inviteCode } = req.body;
    if (!inviteCode) return res.status(400).json({ message: 'Code requis' });

    const league = await prisma.league.findUnique({
      where: { inviteCode: inviteCode.trim().toUpperCase() },
      include: { _count: { select: { members: true } } },
    });
    if (!league) return res.status(404).json({ message: 'Code invalide ou ligue introuvable' });
    if (!league.isActive) return res.status(403).json({ message: 'Cette ligue est fermée' });
    if (league._count.members >= league.maxMembers) return res.status(403).json({ message: 'Ligue complète' });

    const already = await prisma.leagueMember.findUnique({
      where: { leagueId_userId: { leagueId: league.id, userId: req.user.sub } },
    });
    if (already) return res.status(409).json({ message: 'Vous êtes déjà dans cette ligue' });

    await prisma.leagueMember.create({
      data: { leagueId: league.id, userId: req.user.sub },
    });

    res.json({ message: `Vous avez rejoint "${league.name}" !`, league });
  } catch (e) { console.error(e); res.status(500).json({ message: e.message }); }
});

// Détail d'une ligue + classement interne
app.get('/api/v1/leagues/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const league = await prisma.league.findUnique({
      where: { id },
      include: {
        creator: { include: { profile: true } },
        members: {
          include: { user: { include: { profile: true } } },
          orderBy: { joinedAt: 'asc' },
        },
        _count: { select: { members: true } },
      },
    });
    if (!league) return res.status(404).json({ message: 'Ligue introuvable' });

    // Vérifier que l'utilisateur est membre
    const isMember = league.members.some(m => m.userId === req.user.sub);
    if (!isMember && league.visibility === 'PRIVATE')
      return res.status(403).json({ message: 'Accès refusé' });

    // Calculer le classement interne
    const memberIds = league.members.map(m => m.userId);
    const profiles = await prisma.userProfile.findMany({
      where: { userId: { in: memberIds } },
      orderBy: [{ totalPoints: 'desc' }, { exactScores: 'desc' }],
    });

    const rankings = profiles.map((p, i) => ({
      rank: i + 1,
      userId: p.userId,
      username: p.username,
      avatarUrl: p.avatarUrl,
      points: p.totalPoints,
      exactScores: p.exactScores,
      totalPredictions: p.totalPredictions,
      correctPredictions: p.correctPredictions,
    }));

    res.json({ ...league, rankings });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Quitter une ligue
app.delete('/api/v1/leagues/:id/leave', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const league = await prisma.league.findUnique({ where: { id } });
    if (!league) return res.status(404).json({ message: 'Ligue introuvable' });
    if (league.creatorId === req.user.sub)
      return res.status(403).json({ message: 'Le créateur ne peut pas quitter sa propre ligue' });

    await prisma.leagueMember.delete({
      where: { leagueId_userId: { leagueId: id, userId: req.user.sub } },
    });
    res.json({ message: 'Vous avez quitté la ligue' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Supprimer une ligue (créateur seulement)
app.delete('/api/v1/leagues/:id', auth, async (req, res) => {
  try {
    const { id } = req.params;
    const league = await prisma.league.findUnique({ where: { id } });
    if (!league) return res.status(404).json({ message: 'Ligue introuvable' });
    if (league.creatorId !== req.user.sub)
      return res.status(403).json({ message: 'Seul le créateur peut supprimer la ligue' });

    await prisma.league.update({ where: { id }, data: { isActive: false } });
    res.json({ message: 'Ligue supprimée' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ══════════════════════════════════════════════════════════════════
// ── ADMIN — Sync & Calcul manuel ──────────────────────────────────
// ══════════════════════════════════════════════════════════════════

// Sync + calcul manuel (admin uniquement)
app.post('/api/v1/admin/sync', auth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!['ADMIN','SUPER_ADMIN'].includes(user?.role)) return res.status(403).json({ message: 'Admin requis' });
    const result = await syncResultsAndCalculate();
    res.json({ message: 'Sync terminée', ...result });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Forcer le calcul pour UN match spécifique (admin)
app.post('/api/v1/admin/calculate/:matchId', auth, async (req, res) => {
  try {
    const user = await prisma.user.findUnique({ where: { id: req.user.sub } });
    if (!['ADMIN','SUPER_ADMIN'].includes(user?.role)) return res.status(403).json({ message: 'Admin requis' });

    const { matchId } = req.params;
    const match = await prisma.match.findUnique({ where: { id: matchId } });
    if (!match) return res.status(404).json({ message: 'Match introuvable' });
    if (match.status !== 'FINISHED') return res.status(400).json({ message: `Match pas encore terminé (status: ${match.status})` });

    // Réinitialiser les pronostics déjà calculés pour recalculer
    if (req.query.force === 'true') {
      await prisma.prediction.updateMany({
        where: { matchId, result: { not: 'PENDING' } },
        data: { result: 'PENDING', pointsEarned: 0, bonusPerfect: false, isLockedIn: false, processedAt: null },
      });
    }

    const count = await processMatchPoints(matchId);
    res.json({ message: `${count} pronostics calculés pour le match ${matchId}`, matchId, count });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// Statut du cron + dernier sync
app.get('/api/v1/admin/status', auth, async (req, res) => {
  try {
    const finishedMatches = await prisma.match.count({ where: { status: 'FINISHED' } });
    const pendingPreds    = await prisma.prediction.count({ where: { result: 'PENDING', match: { status: 'FINISHED' } } });
    const calculatedPreds = await prisma.prediction.count({ where: { result: { not: 'PENDING' } } });
    res.json({
      cronActive:       !!syncInterval,
      finishedMatches,
      pendingPredictions: pendingPreds,   // pronostics pas encore calculés
      calculatedPredictions: calculatedPreds,
      serverTime: new Date().toISOString(),
    });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── 404 ───────────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ message: `Route ${req.path} introuvable` }));

// ── Start ─────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  await prisma.$connect();
  console.log('\n🚀 ================================');
  console.log(`   FIFA 2026 API — Port ${PORT}`);
  console.log('   http://localhost:3001/api/v1');
  console.log('================================\n');
});


