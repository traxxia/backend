const SCORE_MAP = {
  'low': 1,
  'small': 1,
  'medium': 2,
  'high': 3,
  'large': 3
};

function getScoreValue(value) {
  if (!value) return 1; // Default to 1 if not set
  const val = String(value).toLowerCase().trim();
  return SCORE_MAP[val] || 1;
}

/**
 * Calculates the priority score for a project.
 * Priority = (Impact * 3) - (Effort * 2) - (Risk * 2)
 * Normalized Score = ((raw + 9) / 14) * 10
 * 
 * @param {string} impact - 'Low', 'Medium', 'High'
 * @param {string} effort - 'Small', 'Medium', 'Large'
 * @param {string} risk - 'Low', 'Medium', 'High'
 * @returns {number} Normalized score (0-10)
 */
function calculateProjectScore(impact, effort, risk) {
  const i = getScoreValue(impact);
  const e = getScoreValue(effort);
  const r = getScoreValue(risk);

  // Raw Priority Score calculation
  // Impact range: [1, 3] * 3 = [3, 9]
  // Effort range: [1, 3] * 2 = [2, 6]
  // Risk range: [1, 3] * 2 = [2, 6]
  // Raw Score range: [3 - 6 - 6, 9 - 2 - 2] = [-9, 5]
  const rawScore = (i * 3) - (e * 2) - (r * 2);

  // Normalized Score calculation
  // (rawScore + 9) range: [0, 14]
  // Normalized range: [0/14 * 10, 14/14 * 10] = [0, 10]
  const normalizedScore = ((rawScore + 9) / 14) * 10;

  return Math.round(normalizedScore * 10) / 10; // Round to 1 decimal place
}

module.exports = {
  calculateProjectScore
};
