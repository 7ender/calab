package gateway

import (
	"github.com/redis/rueidis"
	"google.golang.org/protobuf/types/known/timestamppb"
)

func isNil(err error) bool { return rueidis.IsRedisNil(err) }

func nowTS() *timestamppb.Timestamp { return timestamppb.Now() }
