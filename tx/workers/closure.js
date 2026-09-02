//
// Closure Worker - Handles ConceptMap $closure operation
//
// GET /ConceptMap/$closure?{params}
// POST /ConceptMap/$closure
//

const { buildOperationOutcome } = require('../library/operation-outcome');

class ClosureWorker {
  /**
   * Handle a $closure request
   * @param {express.Request} req - Express request (with txProvider attached)
   * @param {express.Response} res - Express response
   * @param {Object} log - Logger instance
   */
  static handle(req, res) {
    const params = req.method === 'POST' ? req.body : req.query;

    this.log.debug('ConceptMap $closure with params:', params);

    // TODO: Implement closure logic using provider
    res.status(501).json(buildOperationOutcome('error', 'not-supported', 'ConceptMap $closure operation not yet implemented'));
  }
}

module.exports = ClosureWorker;
