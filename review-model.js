/* 입력·복원·서버 응답에서 같은 평점 규칙을 쓰기 위해 한곳에 모은다. */
(function (root) {
  "use strict";
  function rating(value) {
    return typeof value === "number" && Number.isFinite(value) && value >= 0.5 && value <= 5 && Number.isInteger(value * 2) ? value : null;
  }
  function draft(value) {
    // 업데이트 전에 쓰던 문자열 한줄평도 그대로 복원한다.
    if (typeof value === "string") return { review: value, rating: null };
    return { review: typeof value?.review === "string" ? value.review : "", rating: rating(value?.rating) };
  }
  function hasContent(value) { return !!value.review.trim() || rating(value.rating) !== null; }
  function pointerRating(star, clientX, left, width) { return star - (clientX <= left + width / 2 ? 0.5 : 0); }
  function stars(value) {
    const score = rating(value) || 0;
    return [1, 2, 3, 4, 5].map((n) => {
      const fill = Math.max(0, Math.min(1, score - n + 1)) * 100;
      return `<span class="star-glyph" aria-hidden="true"><span>☆</span><span class="star-fill" style="width:${fill}%">★</span></span>`;
    });
  }
  const model = { rating, draft, hasContent, pointerRating, stars };
  if (typeof module === "object" && module.exports) module.exports = model;
  else root.ReviewModel = model;
})(globalThis);
