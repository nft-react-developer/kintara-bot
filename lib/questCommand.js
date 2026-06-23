function nonNegativeInt(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.floor(number)) : 0;
}

function questList(snapshot = {}) {
  const cfg = snapshot?.dailyQuestConfig || {};
  return Array.isArray(cfg.quests) ? cfg.quests : [];
}

function questState(snapshot = {}) {
  const dq = snapshot?.dailyQuest || {};
  return {
    day: dq.day || '?',
    prog: dq.prog && typeof dq.prog === 'object' ? { ...dq.prog } : {},
    claimed: dq.claimed && typeof dq.claimed === 'object' ? { ...dq.claimed } : {},
  };
}

function questProgressFor(state, quest) {
  return nonNegativeInt(state.prog?.[quest.id]);
}

function questTarget(quest) {
  return Math.max(1, nonNegativeInt(quest?.target));
}

function questLabel(quest) {
  return String(quest?.label || quest?.kind || quest?.id || 'Quest');
}

function isQuestClaimable(state, quest) {
  if (!quest || !quest.id) return false;
  return questProgressFor(state, quest) >= questTarget(quest) && !state.claimed?.[quest.id];
}

function formatQuestStatus(snapshot = {}, claimSummary = {}) {
  const quests = questList(snapshot);
  const state = questState(snapshot);
  if (!quests.length) return `📋 <b>Daily Quest</b> (${state.day})\n(no quests available today)`;

  const lines = quests.map((quest) => {
    const pr = questProgressFor(state, quest);
    const target = questTarget(quest);
    const claimed = !!state.claimed[quest.id];
    return `${claimed ? '✅' : pr >= target ? '🎁' : '▫️'} ${questLabel(quest)} — ${pr}/${target} (${nonNegativeInt(quest.rewardXpSpreadTotal)}XP)`;
  });

  const claimed = Array.isArray(claimSummary.claimed) ? claimSummary.claimed : [];
  const failed = Array.isArray(claimSummary.failed) ? claimSummary.failed : [];
  const notes = [];
  if (claimed.length) notes.push(`🎁 Auto-claimed: ${claimed.join(', ')}`);
  if (failed.length) notes.push(`⚠️ Claim failed: ${failed.join(', ')}`);

  return [`📋 <b>Daily Quest</b> (${state.day})`, ...notes, ...lines].join('\n');
}

async function claimReadyDailyQuests(client, snapshot) {
  if (!client || typeof client.dailyQuestClaim !== 'function') throw new Error('daily quest client is required');
  let current = snapshot || {};
  if (!snapshot) {
    if (typeof client.dailyQuestProgress !== 'function') throw new Error('daily quest progress client is required');
    current = await client.dailyQuestProgress();
  }

  const quests = questList(current);
  const state = questState(current);
  const claimed = [];
  const failed = [];
  let changed = false;

  for (const quest of quests) {
    if (!isQuestClaimable(state, quest)) continue;
    try {
      const result = await client.dailyQuestClaim(quest.id);
      if (result?.error || result?.ok === false) {
        failed.push(questLabel(quest));
        continue;
      }
      state.claimed[quest.id] = true;
      claimed.push(questLabel(quest));
      changed = true;
    } catch {
      failed.push(questLabel(quest));
    }
  }

  let finalSnapshot = current;
  if (changed && typeof client.dailyQuestProgress === 'function') {
    try {
      finalSnapshot = await client.dailyQuestProgress();
    } catch {
      finalSnapshot = {
        ...current,
        dailyQuest: {
          ...(current.dailyQuest || {}),
          claimed: state.claimed,
        },
      };
    }
  }

  return { snapshot: finalSnapshot, claimed, failed };
}

async function buildQuestCommandMessage(client) {
  const firstSnapshot = await client.dailyQuestProgress().catch(() => ({}));
  const result = await claimReadyDailyQuests(client, firstSnapshot);
  return formatQuestStatus(result.snapshot, result);
}

module.exports = {
  claimReadyDailyQuests,
  formatQuestStatus,
  buildQuestCommandMessage,
  isQuestClaimable,
};
