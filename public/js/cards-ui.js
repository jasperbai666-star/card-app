/** Render a playing card into a container element */
window.CardsUI = {
  render(container, card, { flip = false } = {}) {
    if (!container) return;
    if (!card) {
      container.innerHTML = `<div class="card-empty">暂未分配</div><div class="card-level">等级 —</div>`;
      return;
    }
    let html;
    if (card.isJoker) {
      const small = card.rank === 'joker_small';
      html = `
        <div class="card-face joker ${small ? 'small' : ''} ${flip ? 'flip' : ''}">
          <div class="joker-art">
            <div class="big">${small ? '🃏' : '👑'}</div>
            <div class="tag">${card.label}</div>
          </div>
        </div>
        <div class="card-level">等级 Lv.${card.level} · ${card.label}</div>
      `;
    } else {
      const color = card.color === 'red' ? 'red' : 'black';
      html = `
        <div class="card-face ${color} ${flip ? 'flip' : ''}">
          <div class="corner">
            <span>${card.label}</span>
            <span>${card.symbol}</span>
          </div>
          <div class="center-sym">${card.symbol}</div>
          <div class="corner br">
            <span>${card.label}</span>
            <span>${card.symbol}</span>
          </div>
        </div>
        <div class="card-level">等级 Lv.${card.level} · ${card.suitLabel || ''}${card.label}</div>
      `;
    }
    container.innerHTML = html;
  },

  mini(card) {
    if (!card) return '<span style="color:var(--muted)">未分配</span>';
    if (card.isJoker) {
      return `<span style="color:var(--gold2)">${card.label}</span>`;
    }
    const c = card.color === 'red' ? 'var(--red)' : 'var(--text)';
    return `<span style="color:${c}">${card.symbol}${card.label}</span>`;
  },
};
