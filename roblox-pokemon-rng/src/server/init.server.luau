--!nonstrict
--[[
	PokeRNG -- server bootstrap.

	Services are plain modules with an optional `init(ctx)` and `start()`. The
	two phases matter: every service gets its dependencies before any service
	starts listening, so a remote that fires on the very first frame can never
	reach a half-wired handler.

	`ctx` is passed by hand rather than pulled in with requires because several
	of these services genuinely need each other (a roll updates the leaderboard,
	the shop updates the buddy), and a shared context is easier to follow than a
	cycle of requires.
]]

local Players = game:GetService("Players")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Net = require(Shared.Net)

local Log = require(script.Util.Log)
local DataService = require(script.Data.DataService)

local InventoryService = require(script.Services.InventoryService)
local LuckService = require(script.Services.LuckService)
local PassService = require(script.Services.PassService)
local RollService = require(script.Services.RollService)
local ShopService = require(script.Services.ShopService)
local RewardService = require(script.Services.RewardService)
local LeaderboardService = require(script.Services.LeaderboardService)
local BuddyService = require(script.Services.BuddyService)
local SyncService = require(script.Services.SyncService)
local WorldBuilder = require(script.World.WorldBuilder)

local remotes = Net.build()

local function notify(player: Player, text: string, kind: string?)
	remotes.Notify:FireClient(player, { text = text, kind = kind or "info" })
end

local ctx = {
	remotes = remotes,
	notify = notify,
	dataService = DataService,
	inventoryService = InventoryService,
	luckService = LuckService,
	passService = PassService,
	rollService = RollService,
	shopService = ShopService,
	rewardService = RewardService,
	leaderboardService = LeaderboardService,
	buddyService = BuddyService,
	syncService = SyncService,
}

-- Phase 1: wire.
PassService.init({ dataService = DataService, notify = notify })
RollService.init(ctx)
ShopService.init(ctx)
RewardService.init(ctx)
LeaderboardService.init(ctx)
BuddyService.init(ctx)
SyncService.init(ctx)

--[[
	The Roblox player list. Coins are abbreviated into a StringValue because a
	nine-digit coin balance is unreadable in that column.
]]
local function buildLeaderstats(player: Player)
	local stats = Instance.new("Folder")
	stats.Name = "leaderstats"

	local coins = Instance.new("StringValue")
	coins.Name = "Coins"
	coins.Value = "0"
	coins.Parent = stats

	local level = Instance.new("IntValue")
	level.Name = "Level"
	level.Value = 1
	level.Parent = stats

	local rarest = Instance.new("StringValue")
	rarest.Name = "Rarest"
	rarest.Value = "-"
	rarest.Parent = stats

	stats.Parent = player
end

Players.PlayerAdded:Connect(buildLeaderstats)
for _, player in Players:GetPlayers() do
	if not player:FindFirstChild("leaderstats") then
		buildLeaderstats(player)
	end
end

-- Fill the player list in once the profile behind it exists.
DataService.Loaded:Connect(function(player, profile)
	RollService.updateLeaderstats(player, profile)

	if profile._readOnly then
		notify(player, "Your save could not be loaded. Progress will NOT be saved this session.", "error")
	end
end)

-- Phase 2: build the map, then start listening.
WorldBuilder.build()

DataService.start()
PassService.start()
RollService.start()
ShopService.start()
RewardService.start()
LeaderboardService.start()
BuddyService.start()
SyncService.start()

-- Keep the physical boards in step with the ones in the UI. The first fetch
-- happens on a short poll so a fresh server shows something quickly; after that
-- it follows the leaderboard's own refresh cadence.
task.spawn(function()
	local drawn = 0
	while true do
		local data = LeaderboardService.get()
		if data.fetchedAt > drawn then
			drawn = data.fetchedAt
			WorldBuilder.updateBoards(data)
		end
		task.wait(5)
	end
end)

Log.info("Boot", "PokeRNG server ready")
