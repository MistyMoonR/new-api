package model

import (
	"fmt"

	"github.com/QuantumNous/new-api/common"
	"gorm.io/gorm"
)

type RankingQuotaTotal struct {
	ModelName   string `json:"model_name"`
	TotalTokens int64  `json:"total_tokens"`
}

type RankingQuotaBucket struct {
	ModelName string `json:"model_name"`
	Bucket    int64  `json:"bucket"`
	Tokens    int64  `json:"tokens"`
}

// LOCAL-PATCH(cachetokens): rankings read from logs instead of quota_data on
// SQLite. quota_data.token_used is aggregated at write time from the two
// prompt/completion columns and therefore under-reports anthropic traffic
// (cache read/write live only in logs.other); historical rows cannot be
// amended retroactively. Aggregating logs directly with the semantic-aware
// CASE fixes history immediately. quota_data keeps other consumers intact.
// Non-SQLite log databases keep the original quota_data implementation.
func GetRankingQuotaTotals(startTime int64, endTime int64) ([]RankingQuotaTotal, error) {
	var rows []RankingQuotaTotal
	var query *gorm.DB
	if tokenStatsUsingSQLite() {
		query = LOG_DB.Table("logs").
			Select(fmt.Sprintf("model_name, SUM(prompt_tokens + %s) + SUM(completion_tokens) AS total_tokens", cacheAddExpr())).
			Where("type = ? AND model_name <> ''", LogTypeConsume).
			Group("model_name").
			Having("SUM(prompt_tokens + "+cacheAddExpr()+") + SUM(completion_tokens) > 0").
			Order("total_tokens DESC")
	} else {
		query = DB.Table("quota_data").
			Select("model_name, sum(token_used) as total_tokens").
			Where("model_name <> ''").
			Group("model_name").
			Having("sum(token_used) > 0").
			Order("total_tokens DESC")
	}
	query = applyRankingQuotaTimeRange(query, startTime, endTime)
	err := query.Find(&rows).Error
	return rows, err
}

func GetRankingQuotaBuckets(startTime int64, endTime int64, bucketSize int64) ([]RankingQuotaBucket, error) {
	if bucketSize <= 0 {
		bucketSize = 3600
	}
	bucketExpr := rankingBucketExpr(bucketSize)
	logsBucketExpr := fmt.Sprintf("(created_at / %d) * %d", bucketSize, bucketSize)
	var rows []RankingQuotaBucket
	var query *gorm.DB
	if tokenStatsUsingSQLite() {
		tokensExpr := fmt.Sprintf("SUM(prompt_tokens + %s) + SUM(completion_tokens)", cacheAddExpr())
		query = LOG_DB.Table("logs").
			Select(fmt.Sprintf("model_name, %s as bucket, %s as tokens", logsBucketExpr, tokensExpr)).
			Where("type = ? AND model_name <> ''", LogTypeConsume).
			Group(fmt.Sprintf("model_name, %s", logsBucketExpr)).
			Having(tokensExpr + " > 0").
			Order("bucket ASC")
	} else {
		query = DB.Table("quota_data").
			Select(fmt.Sprintf("model_name, %s as bucket, sum(token_used) as tokens", bucketExpr)).
			Where("model_name <> ''").
			Group(fmt.Sprintf("model_name, %s", bucketExpr)).
			Having("sum(token_used) > 0").
			Order("bucket ASC")
	}
	query = applyRankingQuotaTimeRange(query, startTime, endTime)
	err := query.Find(&rows).Error
	return rows, err
}

func rankingBucketExpr(bucketSize int64) string {
	if common.UsingMainDatabase(common.DatabaseTypeMySQL) {
		return fmt.Sprintf("FLOOR(created_at / %d) * %d", bucketSize, bucketSize)
	}
	return fmt.Sprintf("(created_at / %d) * %d", bucketSize, bucketSize)
}

func applyRankingQuotaTimeRange(query *gorm.DB, startTime int64, endTime int64) *gorm.DB {
	if startTime > 0 {
		query = query.Where("created_at >= ?", startTime)
	}
	if endTime > 0 {
		query = query.Where("created_at <= ?", endTime)
	}
	return query
}
