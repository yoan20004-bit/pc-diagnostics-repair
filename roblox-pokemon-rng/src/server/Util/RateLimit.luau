--!nonstrict
--[[
	RateLimit
	Token buckets, keyed per player per action.

	Remotes are the only place an exploiter can reach the server, so every
	handler passes through here before it touches a profile. A player who blows
	their budget is ignored, not kicked -- a laggy client firing a queued burst
	looks identical to a mild exploiter, and dropping the extra calls costs an
	honest player nothing.
]]

local Players = game:GetService("Players")

local RateLimit = {}

local buckets = {}

--[[
	`rate` is sustained calls per second, `burst` is how many can arrive at once.
]]
function RateLimit.check(player: Player, action: string, rate: number, burst: number?): boolean
	local capacity = burst or rate

	local playerBuckets = buckets[player.UserId]
	if not playerBuckets then
		playerBuckets = {}
		buckets[player.UserId] = playerBuckets
	end

	local bucket = playerBuckets[action]
	local now = os.clock()

	if not bucket then
		bucket = { tokens = capacity, updated = now }
		playerBuckets[action] = bucket
	end

	bucket.tokens = math.min(capacity, bucket.tokens + (now - bucket.updated) * rate)
	bucket.updated = now

	if bucket.tokens < 1 then
		return false
	end

	bucket.tokens -= 1
	return true
end

Players.PlayerRemoving:Connect(function(player)
	buckets[player.UserId] = nil
end)

return RateLimit
