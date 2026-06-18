const SKILL_KEYS = [
  'combat',
  'woodcutting',
  'mining',
  'fishing',
  'cooking',
  'smithing',
];

const PRE_SMITHING_SKILL_KEYS = [
  'combat',
  'woodcutting',
  'mining',
  'fishing',
  'cooking',
];

const MAX_SKILL_LEVEL = 30;
const LEVEL1_XP_BASE = 480;

const THRESH = [0];
for (let k = 1; k < MAX_SKILL_LEVEL; k++) {
  THRESH.push((LEVEL1_XP_BASE * (Math.pow(1.2, k) - 1)) / 0.2);
}

const MAX_TOTAL_XP =
  THRESH[MAX_SKILL_LEVEL - 1] + (THRESH[MAX_SKILL_LEVEL - 1] - THRESH[MAX_SKILL_LEVEL - 2]);

function clampXp(xp) {
  const n = Math.floor(Number(xp) || 0);
  return Math.max(0, Math.min(MAX_TOTAL_XP, n));
}

function levelFromTotalXp(xp) {
  const x = clampXp(xp);
  let lvl = 1;
  for (let i = 1; i < THRESH.length; i++) {
    if (x >= THRESH[i]) lvl = i + 1;
  }
  return Math.min(MAX_SKILL_LEVEL, lvl);
}

function progressWithinLevel(xp) {
  const x = clampXp(xp);
  const lvl = levelFromTotalXp(x);
  if (lvl >= MAX_SKILL_LEVEL) return 1;
  const low = THRESH[lvl - 1];
  const high = THRESH[lvl];
  return (x - low) / Math.max(1, high - low);
}

function levelFloatFromXp(xp) {
  const lvl = levelFromTotalXp(xp);
  if (lvl >= MAX_SKILL_LEVEL) return MAX_SKILL_LEVEL;
  return lvl + progressWithinLevel(xp);
}

function preciseAverageLevel(xpBySkill = {}) {
  let sum = 0;
  for (const key of PRE_SMITHING_SKILL_KEYS) sum += levelFloatFromXp(xpBySkill[key] || 0);
  const avg = sum / PRE_SMITHING_SKILL_KEYS.length;
  if (!Number.isFinite(avg)) return 1;
  return Math.max(1, Math.min(MAX_SKILL_LEVEL, avg));
}

function averageLevelFloor(xpBySkill = {}) {
  return Math.max(1, Math.min(MAX_SKILL_LEVEL, Math.floor(preciseAverageLevel(xpBySkill))));
}

function formatSkillBandProgressShort(xp) {
  const x = clampXp(xp);
  const lvl = levelFromTotalXp(x);
  if (lvl >= MAX_SKILL_LEVEL) {
    return `${Math.round(x).toLocaleString()} / ${Math.round(MAX_TOTAL_XP).toLocaleString()} XP (max)`;
  }
  const low = THRESH[lvl - 1];
  const high = THRESH[lvl];
  const span = Math.max(1, high - low);
  const got = Math.max(0, x - low);
  return `${Math.round(got).toLocaleString()} / ${Math.round(span).toLocaleString()} XP`;
}

module.exports = {
  SKILL_KEYS,
  MAX_SKILL_LEVEL,
  levelFromTotalXp,
  progressWithinLevel,
  levelFloatFromXp,
  preciseAverageLevel,
  averageLevelFloor,
  formatSkillBandProgressShort,
};
