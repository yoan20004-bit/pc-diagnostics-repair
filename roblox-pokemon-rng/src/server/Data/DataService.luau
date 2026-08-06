--!nonstrict
--[[
	DataService
	Profile loading, saving and session ownership.

	Design notes worth knowing before changing anything here:

	  * A failed load never falls back to a fresh profile. Handing a player an
	    empty save because the DataStore was briefly unavailable looks exactly
	    like a wipe, and they will save over their real data the moment they roll.
	    Instead the player gets a read-only temporary profile and a visible
	    warning, and nothing is ever written back for them.

	  * Sessions are soft-locked. The lock records a job id and a heartbeat that
	    autosave refreshes. Another server will wait for a live lock and only
	    take it over once the heartbeat has gone stale, which covers the case
	    where a server crashed without releasing.

	  * Saves go through UpdateAsync, not SetAsync, so a save and a lock refresh
	    can never interleave into a lost update.
]]

local DataStoreService = game:GetService("DataStoreService")
local Players = game:GetService("Players")
local RunService = game:GetService("RunService")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Config = require(Shared.Config)
local Signal = require(Shared.Signal)

local Schema = require(script.Parent.Schema)
local Log = require(script.Parent.Parent.Util.Log)

local DataService = {}

-- Fired whenever a profile changes and the client should be re-synced.
DataService.Changed = Signal.new()
-- Fired once per player after their profile is ready to use.
DataService.Loaded = Signal.new()

local store = DataStoreService:GetDataStore(Config.Data.StoreName)

local profiles: { [number]: any } = {}
local dirty: { [number]: boolean } = {}
local shuttingDown = false

-- How long a lock heartbeat stays valid before another server may take it.
local LOCK_STALE_SECONDS = 120
-- How long we'll wait for a live lock to clear before forcing a takeover.
local LOCK_WAIT_ATTEMPTS = 6
local LOCK_WAIT_INTERVAL = 5

local function keyFor(userId: number): string
	return Config.Data.KeyPrefix .. tostring(userId)
end

--[[
	Retry wrapper. DataStore failures are usually transient (throttling, a brief
	outage), so back off and try again rather than surfacing the first error.
]]
local function retry<T>(label: string, fn: () -> T): (boolean, T?)
	local delaySeconds = 1
	for attempt = 1, Config.Data.MaxRetries do
		local ok, result = pcall(fn)
		if ok then
			return true, result
		end

		Log.warn("Data", "%s failed (attempt %d/%d): %s", label, attempt, Config.Data.MaxRetries, tostring(result))
		if attempt < Config.Data.MaxRetries then
			task.wait(delaySeconds)
			delaySeconds *= Config.Data.RetryBackoff
		end
	end
	return false, nil
end

local function isLockHeldElsewhere(lock: any): boolean
	if type(lock) ~= "table" then
		return false
	end
	if lock.jobId == game.JobId then
		return false
	end
	return (os.time() - (lock.heartbeat or 0)) < LOCK_STALE_SECONDS
end

--[[
	Claim the profile for this server and return the stored data.
	`force` skips the "is someone else holding it" check, used on the final
	attempt so a permanently stuck lock can't lock a player out of their own save.
]]
local function acquire(userId: number, force: boolean): (boolean, any, boolean)
	local blocked = false

	local ok, result = retry("acquire", function()
		return store:UpdateAsync(keyFor(userId), function(stored)
			if not force and isLockHeldElsewhere(stored and stored.lock) then
				blocked = true
				-- Returning nil aborts the transaction and leaves the value untouched.
				return nil
			end

			local data = stored or { profile = nil }
			data.lock = { jobId = game.JobId, heartbeat = os.time() }
			return data
		end)
	end)

	if blocked then
		return false, nil, true
	end
	if not ok then
		return false, nil, false
	end

	return true, result and result.profile or nil, false
end

function DataService.load(player: Player)
	local userId = player.UserId

	-- `acquired` is the part that matters: it separates "the store answered and
	-- there was no profile" (a genuinely new player) from "the store never
	-- answered" (do not, under any circumstances, hand out a fresh profile).
	local acquired = false
	local stored = nil

	for attempt = 1, LOCK_WAIT_ATTEMPTS do
		local force = attempt == LOCK_WAIT_ATTEMPTS
		local ok, data, wasBlocked = acquire(userId, force)

		if ok then
			acquired = true
			stored = data
			break
		end
		if not wasBlocked then
			-- A hard failure, not contention. Stop retrying the lock.
			break
		end

		Log.warn("Data", "profile for %s is locked by another server, waiting", player.Name)
		task.wait(LOCK_WAIT_INTERVAL)
		if not player.Parent then
			return
		end
	end

	if not player.Parent then
		-- Left while we were loading; release so the next server isn't blocked.
		DataService.release(userId)
		return
	end

	local profile
	local readOnly = false

	if acquired and stored ~= nil then
		profile = stored
		Schema.migrate(profile)
		Schema.sanitise(profile)
	elseif acquired then
		profile = Schema.sanitise(Schema.default())
	else
		profile = Schema.sanitise(Schema.default())
		readOnly = true
	end

	profile._readOnly = readOnly
	profile._joinedAt = os.time()
	profiles[userId] = profile

	if readOnly then
		Log.warn("Data", "%s is on a read-only profile -- saves are disabled for this session", player.Name)
	else
		Log.info("Data", "loaded profile for %s (level %d, %d rolls)", player.Name, profile.level, profile.rolls)
	end

	DataService.Loaded:Fire(player, profile)
	DataService.Changed:Fire(player, profile)
end

function DataService.get(player: Player): any?
	return profiles[player.UserId]
end

function DataService.isReadOnly(player: Player): boolean
	local profile = profiles[player.UserId]
	return profile ~= nil and profile._readOnly == true
end

--[[
	Mark a profile as needing a save and tell the client to re-render.
	Services mutate the profile table directly and then call this.
]]
function DataService.markDirty(player: Player)
	local profile = profiles[player.UserId]
	if not profile then
		return
	end
	dirty[player.UserId] = true
	DataService.Changed:Fire(player, profile)
end

--[[
	Strip the runtime-only fields before anything is written.

	Any key beginning with an underscore is runtime-only, by convention. That is
	deliberately a blanket rule rather than a list: services attach derived
	caches to the profile (InventoryService keeps `_bonuses` there, which holds
	per-tier and per-type progress), and a list would silently start persisting
	the next one somebody adds. Persisting a cache is worse than merely wasting
	DataStore quota -- it would be reloaded next session and trusted as current.
]]
local function serialisable(profile: any): any
	local copy = {}
	for key, value in profile do
		if type(key) ~= "string" or string.sub(key, 1, 1) ~= "_" then
			copy[key] = value
		end
	end
	return copy
end

function DataService.save(player: Player, releaseLock: boolean?): boolean
	local userId = player.UserId
	local profile = profiles[userId]
	if not profile then
		return false
	end
	if profile._readOnly then
		return false
	end

	if profile._joinedAt then
		profile.playtime = (profile.playtime or 0) + (os.time() - profile._joinedAt)
		profile._joinedAt = os.time()
	end
	profile.lastSeen = os.time()

	local payload = serialisable(profile)

	local ok = retry("save", function()
		return store:UpdateAsync(keyFor(userId), function(stored)
			local data = stored or {}
			-- Only write if we still hold the lock, or nobody does. If another
			-- server took over while we were running, its data wins.
			local lock = data.lock
			if type(lock) == "table" and lock.jobId ~= game.JobId and isLockHeldElsewhere(lock) then
				return nil
			end

			data.profile = payload
			if releaseLock then
				data.lock = nil
			else
				data.lock = { jobId = game.JobId, heartbeat = os.time() }
			end
			return data
		end)
	end)

	if ok then
		dirty[userId] = nil
	else
		Log.warn("Data", "could not save profile for %s", player.Name)
	end
	return ok
end

--[[
	Bump the lock heartbeat without rewriting the profile. Cheaper than a full
	save for an idle player, and it is what keeps another server from concluding
	this session has died.
]]
function DataService.refreshLock(userId: number)
	retry("heartbeat", function()
		return store:UpdateAsync(keyFor(userId), function(stored)
			local data = stored or {}
			local lock = data.lock
			if type(lock) == "table" and lock.jobId ~= game.JobId and isLockHeldElsewhere(lock) then
				return nil
			end
			data.lock = { jobId = game.JobId, heartbeat = os.time() }
			return data
		end)
	end)
end

--[[
	Drop our claim on a profile without writing one. Used when a player leaves
	mid-load.
]]
function DataService.release(userId: number)
	retry("release", function()
		return store:UpdateAsync(keyFor(userId), function(stored)
			if type(stored) == "table" and type(stored.lock) == "table" and stored.lock.jobId == game.JobId then
				stored.lock = nil
			end
			return stored
		end)
	end)
end

function DataService.unload(player: Player)
	local userId = player.UserId
	if profiles[userId] then
		DataService.save(player, true)
	else
		DataService.release(userId)
	end
	profiles[userId] = nil
	dirty[userId] = nil
end

function DataService.start()
	Players.PlayerAdded:Connect(function(player)
		task.spawn(DataService.load, player)
	end)

	for _, player in Players:GetPlayers() do
		task.spawn(DataService.load, player)
	end

	Players.PlayerRemoving:Connect(function(player)
		DataService.unload(player)
	end)

	-- Autosave. A profile with no changes since the last write still needs its
	-- session lock heartbeat refreshed, otherwise another server will decide
	-- this session died and take the profile over mid-play.
	task.spawn(function()
		while not shuttingDown do
			task.wait(Config.Data.AutosaveInterval)
			for _, player in Players:GetPlayers() do
				local profile = profiles[player.UserId]
				if profile and not profile._readOnly then
					if dirty[player.UserId] then
						DataService.save(player, false)
					else
						DataService.refreshLock(player.UserId)
					end
					-- Spread writes out; DataStore budgets are per-server.
					task.wait(0.2)
				end
			end
		end
	end)

	game:BindToClose(function()
		shuttingDown = true
		if RunService:IsStudio() then
			return
		end

		local pending = 0
		for _, player in Players:GetPlayers() do
			pending += 1
			task.spawn(function()
				DataService.save(player, true)
				pending -= 1
			end)
		end

		local deadline = os.clock() + 25
		while pending > 0 and os.clock() < deadline do
			task.wait(0.1)
		end
		Log.info("Data", "shutdown saves complete")
	end)
end

return DataService
