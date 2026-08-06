--!nonstrict
--[[
	SyncService
	Turns a profile into the snapshot the client renders, and pushes it.

	Pushes are coalesced. A burst of auto-rolls can mark a profile dirty many
	times a second, and the client only needs the latest state -- so changes set
	a flag and a single loop flushes at most every SYNC_INTERVAL.

	The snapshot deliberately carries derived values (current luck, current
	cooldown, xp needed for the next level) rather than the inputs to them. The
	client already has the shared modules and could recompute most of it, but
	then two implementations of the same formula would have to agree forever.
]]

local Players = game:GetService("Players")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Config = require(Shared.Config)
local Upgrades = require(Shared.Upgrades)

local InventoryService = require(script.Parent.InventoryService)
local LuckService = require(script.Parent.LuckService)
local RewardService = require(script.Parent.RewardService)

local SyncService = {}

local SYNC_INTERVAL = 0.2

local pending: { [number]: boolean } = {}
local ctx

function SyncService.init(dependencies)
	ctx = dependencies
end

function SyncService.snapshot(player: Player, profile: any)
	local stats = LuckService.compute(player, profile)
	local bonuses = InventoryService.bonuses(profile)

	local index = {}
	for speciesKey in profile.index do
		local speciesId = tonumber(speciesKey)
		if speciesId then
			table.insert(index, speciesId)
		end
	end

	-- Effects go out as remaining seconds. Absolute expiry would force the
	-- client to trust its own clock against the server's.
	local now = os.time()
	local effects = {}
	for _, effect in profile.effects do
		local remaining = (effect.expires or 0) - now
		if remaining > 0 then
			local potion = Upgrades.potionsById[effect.potionId]
			table.insert(effects, {
				potionId = effect.potionId,
				name = potion and potion.name or effect.potionId,
				remaining = remaining,
			})
		end
	end

	return {
		coins = profile.coins,
		lifetimeCoins = profile.lifetimeCoins,
		level = profile.level,
		xp = profile.xp,
		xpNeeded = LuckService.xpForLevel(profile.level),
		maxLevel = Config.Economy.MaxLevel,
		prestige = profile.prestige,
		rolls = profile.rolls,

		luck = stats.luck,
		variantLuck = stats.variantLuck,
		coinMult = stats.coinMult,
		xpMult = stats.xpMult,
		cooldown = stats.cooldown,
		autoRollUnlocked = stats.autoRoll,
		luckBreakdown = stats.breakdown,

		inventory = InventoryService.snapshot(profile),
		index = index,
		indexCount = bonuses.indexCount,
		indexTotal = bonuses.indexTotal,
		tierProgress = bonuses.tierProgress,
		typeProgress = bonuses.typeProgress,
		tiersComplete = bonuses.tiersComplete,
		typesMastered = bonuses.typesMastered,

		upgrades = profile.upgrades,
		potions = profile.potions,
		effects = effects,

		buddy = profile.buddy,
		best = profile.best,
		settings = profile.settings,
		daily = RewardService.dailyStatus(profile),

		prestigeRequirement = {
			level = Config.Prestige.RequiredLevel,
			index = Config.Prestige.RequiredIndexEntries,
			max = Config.Prestige.MaxPrestige,
		},

		readOnly = ctx.dataService.isReadOnly(player),
	}
end

function SyncService.push(player: Player)
	local profile = ctx.dataService.get(player)
	if not profile then
		return
	end
	ctx.remotes.StateSync:FireClient(player, SyncService.snapshot(player, profile))
end

function SyncService.start()
	ctx.dataService.Changed:Connect(function(player)
		pending[player.UserId] = true
	end)

	ctx.dataService.Loaded:Connect(function(player)
		task.defer(SyncService.push, player)
	end)

	task.spawn(function()
		while true do
			task.wait(SYNC_INTERVAL)
			for _, player in Players:GetPlayers() do
				if pending[player.UserId] then
					pending[player.UserId] = nil
					SyncService.push(player)
				end
			end
		end
	end)

	-- Potion timers expire on their own schedule, with nothing to mark the
	-- profile dirty. A slow sweep both prunes them and refreshes the countdown
	-- shown on the HUD.
	task.spawn(function()
		while true do
			task.wait(1)
			for _, player in Players:GetPlayers() do
				local profile = ctx.dataService.get(player)
				if profile then
					if LuckService.pruneEffects(profile) then
						ctx.dataService.markDirty(player)
					elseif #profile.effects > 0 then
						pending[player.UserId] = true
					end
				end
			end
		end
	end)

	Players.PlayerRemoving:Connect(function(player)
		pending[player.UserId] = nil
	end)
end

return SyncService
