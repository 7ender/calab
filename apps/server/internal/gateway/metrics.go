package gateway

import (
	"strconv"

	"github.com/coder/websocket"
	"github.com/prometheus/client_golang/prometheus"
	"github.com/prometheus/client_golang/prometheus/promauto"
)

var (
	socketsGauge = promauto.NewGauge(prometheus.GaugeOpts{
		Namespace: "calaba", Subsystem: "gateway", Name: "sockets", Help: "Open gateway sockets."})
	sessionsGauge = promauto.NewGauge(prometheus.GaugeOpts{
		Namespace: "calaba", Subsystem: "gateway", Name: "sessions", Help: "Gateway sessions owned by this instance (incl. detached)."})
	eventsReceived = promauto.NewCounter(prometheus.CounterOpts{
		Namespace: "calaba", Subsystem: "gateway", Name: "events_received_total", Help: "Events received from Redis pub/sub."})
	eventsDispatched = promauto.NewCounter(prometheus.CounterOpts{
		Namespace: "calaba", Subsystem: "gateway", Name: "events_dispatched_total", Help: "DISPATCH frames emitted to sessions."})
	fanoutSeconds = promauto.NewHistogram(prometheus.HistogramOpts{
		Namespace: "calaba", Subsystem: "gateway", Name: "fanout_seconds",
		Help:    "Time to route one pub/sub event to all local sessions.",
		Buckets: []float64{.00005, .0001, .00025, .0005, .001, .0025, .005, .01, .025, .05}})
	closes = promauto.NewCounterVec(prometheus.CounterOpts{
		Namespace: "calaba", Subsystem: "gateway", Name: "closes_total", Help: "Server-initiated socket closes by code."}, []string{"code"})
)

func closeMetric(code websocket.StatusCode) { closes.WithLabelValues(strconv.Itoa(int(code))).Inc() }
