package model

import (
	"fmt"

	"github.com/QuantumNous/new-api/common"
)

// LOCAL-PATCH(cachetokens): token breakdown aggregation over logs with
// usage-semantic awareness. Anthropic-semantic rows keep only the fresh
// (non-cached) input in logs.prompt_tokens, with cache read/write recorded in
// logs.other ($.cache_tokens / $.cache_creation_tokens); OpenAI-semantic rows
// already include cached tokens in prompt_tokens. total_input therefore adds
// the cache fields back for anthropic rows ONLY — adding them for every row
// would double-count OpenAI-semantic traffic.
//
// This aggregation is SQLite-specific: json_extract comparisons against a
// plain string only work on SQLite (MySQL returns quoted JSON strings and
// would silently mismatch). Non-SQLite log databases keep the legacy
// prompt+completion numbers (no cache breakdown).
//
// Mutual exclusion: if the upstream ever normalizes prompt_tokens at write
// time (cf. upstream PR #7291 logInputTokens), anthropic rows would already
// carry the cache inside prompt_tokens while usage_semantic stays
// "anthropic", and this CASE would double-count. Retire the CASE together
// with any such adoption — never run both.

type TokenBreakdownRow struct {
	Bucket     int64  `json:"bucket"`
	ModelName  string `json:"model_name"`
	TotalInput int64  `json:"total_input"`
	FreshInput int64  `json:"fresh_input"`
	CacheRead  int64  `json:"cache_read"`
	CacheWrite int64  `json:"cache_write"`
	Completion int64  `json:"completion"`
	Quota      int64  `json:"quota"`
	Count      int64  `json:"count"`
}

// cacheAddExpr returns the SQLite expression that adds anthropic cache
// tokens back into a summed input column. Shared so the rankings and tpm
// calibrations reuse the exact same semantics as the breakdown endpoint.
func cacheAddExpr() string {
	return "CASE WHEN json_extract(other,'$.usage_semantic') = 'anthropic' " +
		"THEN COALESCE(CAST(json_extract(other,'$.cache_tokens') AS INTEGER), 0) " +
		"+ COALESCE(CAST(json_extract(other,'$.cache_creation_tokens') AS INTEGER), 0) " +
		"ELSE 0 END"
}

func tokenStatsUsingSQLite() bool {
	return common.UsingLogDatabase(common.DatabaseTypeSQLite)
}

// GetTokenBreakdown aggregates consume logs (type=2) into hour buckets per
// model. Time range is inclusive on both ends, matching GetAllQuotaDates so
// dashboard cards filtered the same way stay comparable.
func GetTokenBreakdown(startTimestamp int64, endTimestamp int64, modelName string, username string) ([]TokenBreakdownRow, error) {
	rows := make([]TokenBreakdownRow, 0)

	tx := LOG_DB.Table("logs").Where("type = ?", LogTypeConsume)
	if tokenStatsUsingSQLite() {
		tx = tx.Select(fmt.Sprintf(
			"(created_at / 3600) * 3600 AS bucket, model_name, "+
				"SUM(prompt_tokens + %s) AS total_input, "+
				"SUM(COALESCE(CAST(json_extract(other,'$.cache_tokens') AS INTEGER), 0)) AS cache_read, "+
				"SUM(COALESCE(CAST(json_extract(other,'$.cache_creation_tokens') AS INTEGER), 0)) AS cache_write, "+
				"SUM(completion_tokens) AS completion, SUM(quota) AS quota, COUNT(*) AS count",
			cacheAddExpr()))
	} else {
		// Fallback: legacy two-column totals, cache segments stay zero.
		tx = tx.Select("(created_at / 3600) * 3600 AS bucket, model_name, " +
			"SUM(prompt_tokens) AS total_input, " +
			"SUM(prompt_tokens) AS fresh_input, " +
			"0 AS cache_read, 0 AS cache_write, " +
			"SUM(completion_tokens) AS completion, SUM(quota) AS quota, COUNT(*) AS count")
	}

	if startTimestamp != 0 {
		tx = tx.Where("created_at >= ?", startTimestamp)
	}
	if endTimestamp != 0 {
		tx = tx.Where("created_at <= ?", endTimestamp)
	}
	if modelName != "" {
		tx = tx.Where("model_name = ?", modelName)
	}
	if username != "" {
		tx = tx.Where("username = ?", username)
	}

	if err := tx.Group("bucket, model_name").Order("bucket ASC").Find(&rows).Error; err != nil {
		return nil, err
	}

	if tokenStatsUsingSQLite() {
		for i := range rows {
			// Stack invariant: fresh + cache_read + cache_write == total_input.
			// anthropic rows: fresh = prompt_tokens (cache is additive).
			// openai rows: fresh = prompt_tokens - cache (prompt already
			// includes it), clamped at 0 for dirty rows.
			rows[i].FreshInput = rows[i].TotalInput - rows[i].CacheRead - rows[i].CacheWrite
			if rows[i].FreshInput < 0 {
				rows[i].FreshInput = 0
			}
		}
	}
	return rows, nil
}
