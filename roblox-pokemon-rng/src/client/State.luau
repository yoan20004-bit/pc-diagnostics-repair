--!nonstrict
--[[
	State
	The client's copy of the server snapshot, plus a change signal.

	Panels never read remotes directly. They read State and subscribe to it,
	which means a panel built while the player is mid-session renders correctly
	from the current snapshot instead of waiting for the next push.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Signal = require(Shared.Signal)

local State = {}

State.Changed = Signal.new()
State.LeaderboardChanged = Signal.new()

State.current = nil
State.leaderboard = { rarest = {}, rolls = {}, fetchedAt = 0 }

-- Rolls the client has seen this session, newest first. Purely local: the
-- server does not keep a roll history, and does not need to.
State.recent = {}
State.MAX_RECENT = 40

function State.apply(snapshot: any)
	State.current = snapshot
	State.Changed:Fire(snapshot)
end

function State.applyLeaderboard(data: any)
	State.leaderboard = data
	State.LeaderboardChanged:Fire(data)
end

function State.pushRoll(result: any)
	table.insert(State.recent, 1, result)
	while #State.recent > State.MAX_RECENT do
		table.remove(State.recent)
	end
end

--[[
	How many of a given species/variant the player owns, straight from the last
	snapshot. Linear over the inventory, which is at most a few hundred entries.
]]
function State.countOf(speciesId: number, variantKey: string): number
	local snapshot = State.current
	if not snapshot then
		return 0
	end
	for _, entry in snapshot.inventory do
		if entry.speciesId == speciesId and entry.variantKey == variantKey then
			return entry.count
		end
	end
	return 0
end

function State.isDiscovered(speciesId: number): boolean
	local snapshot = State.current
	if not snapshot then
		return false
	end
	return table.find(snapshot.index, speciesId) ~= nil
end

return State
