package controller

import (
	"net/http"
	"strconv"

	"github.com/QuantumNous/new-api/common"
	"github.com/QuantumNous/new-api/model"

	"github.com/gin-gonic/gin"
)

// LOCAL-PATCH(cachetokens): read-only token breakdown endpoint backing the
// dashboard "Token Distribution" card and the calibrated stat-card total.
// Accepts the same start/end/model/username filters as /api/data so cards
// filtered identically stay comparable.
func GetTokenBreakdown(c *gin.Context) {
	startTimestamp, _ := strconv.ParseInt(c.Query("start_timestamp"), 10, 64)
	endTimestamp, _ := strconv.ParseInt(c.Query("end_timestamp"), 10, 64)
	modelName := c.Query("model_name")
	username := c.Query("username")
	rows, err := model.GetTokenBreakdown(startTimestamp, endTimestamp, modelName, username)
	if err != nil {
		common.ApiError(c, err)
		return
	}
	c.JSON(http.StatusOK, gin.H{
		"success": true,
		"message": "",
		"data":    rows,
	})
}
