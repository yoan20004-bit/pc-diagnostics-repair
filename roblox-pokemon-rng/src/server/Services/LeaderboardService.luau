--!nonstrict
--[[
	LeaderboardService
	Global top-25 boards backed by OrderedDataStores.

	OrderedDataStore values must be signed 64-bit integers, which a rarity of
	1e8 multiplied by stacked variants would blow past. Rarity is therefore
	stored as RollEngine.score(), a log10 scale times a million -- monotonic, so
	ordering is preserved exactly, and it comfortably fits.

	The board is fetched on a timer for the whole server, not per player, so the
	request budget does not scale with player count.
]]

local DataStoreService = game:GetService("DataStoreService")
local Players = game:GetService("Players")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Config = require(Shared.Config)
local RollEngine = require(Shared.RollEngine)

local Log = require(script.Parent.Parent.Util.Log)

local LeaderboardService = {}

local rarestStore = DataStoreService:GetOrderedDataStore(Config.Leaderboard.StoreRarest)
local rollsStore = DataStoreService:GetOrderedDataStore(Config.Leaderboard.StoreRolls)

-- Rarity score can't be reversed into a species, so the display data lives in a
-- normal DataStore alongside the ordered one.
local detailStore = DataStoreService:GetDataStore(Config.Leaderboard.StoreRarest .. "_detail")

local cached = { rarest = {}, rolls = {}, fetchedAt = 0 }
local ctx

function LeaderboardService.init(dependencies)
	ctx = dependencies
end

--[[
	Record a player's personal best on the global board. Only called when the
	best actually improves, so this is a rare write.
]]
function LeaderboardService.submit(player: Player, profile: any)
	if ctx.dataService.isReadOnly(player) then
		return
	end
	if not profile.best then
		return
	end

	local score = RollEngine.score(profile.best.rarity)
	local key = tostring(player.UserId)

	task.spawn(function()
		local ok, err = pcall(function()
			rarestStore:SetAsync(key, score)
			detailStore:SetAsync(key, {
				name = player.Name,
				displayName = player.DisplayName,
				speciesId = profile.best.speciesId,
				variantKey = profile.best.variantKey,
				rarity = profile.best.rarity,
			})
		end)
		if not ok then
			Log.warn("Leaderboard", "rarest submit failed: %s", tostring(err))
		end
	end)
end

function LeaderboardService.submitRolls(player: Player, profile: any)
	if ctx.dataService.isReadOnly(player) then
		return
	end

	task.spawn(function()
		local ok, err = pcall(function()
			rollsStore:SetAsync(tostring(player.UserId), math.floor(profile.rolls))
		end)
		if not ok then
			Log.warn("Leaderboard", "rolls submit failed: %s", tostring(err))
		end
	end)
end

local function fetchPage(store, count: number)
	local ok, pages = pcall(function()
		return store:GetSortedAsync(false, count)
	end)
	if not ok then
		Log.warn("Leaderboard", "fetch failed: %s", tostring(pages))
		return {}
	end

	local ok2, page = pcall(function()
		return pages:GetCurrentPage()
	end)
	if not ok2 then
		return {}
	end

	return page
end

function LeaderboardService.refresh()
	local rarestPage = fetchPage(rarestStore, Config.Leaderboard.TopCount)
	local rarest = {}

	for rank, row in rarestPage do
		local detail
		local ok, result = pcall(function()
			return detailStore:GetAsync(row.key)
		end)
		if ok then
			detail = result
		end

		table.insert(rarest, {
			rank = rank,
			userId = tonumber(row.key) or 0,
			name = detail and (detail.displayName or detail.name) or "Trainer",
			speciesId = detail and detail.speciesId or nil,
			variantKey = detail and detail.variantKey or "",
			rarity = detail and detail.rarity or 10 ^ (row.value / 1e6),
		})
	end

	local rollsPage = fetchPage(rollsStore, Config.Leaderboard.TopCount)
	local rolls = {}
	for rank, row in rollsPage do
		table.insert(rolls, {
			rank = rank,
			userId = tonumber(row.key) or 0,
			rolls = row.value,
		})
	end

	cached = { rarest = rarest, rolls = rolls, fetchedAt = os.time() }
	return cached
end

function LeaderboardService.get()
	return cached
end

function LeaderboardService.start()
	task.spawn(function()
		while true do
			LeaderboardService.refresh()
			ctx.remotes.LeaderboardSync:FireAllClients(cached)
			task.wait(Config.Leaderboard.RefreshInterval)
		end
	end)

	-- Send the current board to anyone joining mid-cycle rather than making
	-- them wait for the next refresh.
	Players.PlayerAdded:Connect(function(player)
		task.defer(function()
			if cached.fetchedAt > 0 then
				ctx.remotes.LeaderboardSync:FireClient(player, cached)
			end
		end)
	end)

	-- Total rolls change constantly; batch them on leave and on a slow timer
	-- instead of writing every roll.
	Players.PlayerRemoving:Connect(function(player)
		local profile = ctx.dataService.get(player)
		if profile then
			LeaderboardService.submitRolls(player, profile)
		end
	end)

	task.spawn(function()
		while true do
			task.wait(300)
			for _, player in Players:GetPlayers() do
				local profile = ctx.dataService.get(player)
				if profile then
					LeaderboardService.submitRolls(player, profile)
					task.wait(1)
				end
			end
		end
	end)
end

return LeaderboardService
