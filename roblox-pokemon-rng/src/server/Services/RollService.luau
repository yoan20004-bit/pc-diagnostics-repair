--!nonstrict
--[[
	RollService
	The core loop. Every roll in the game goes through here, on the server.

	The client never rolls. It asks. It cannot say what it rolled, how lucky it
	was, or how long it waited -- all it sends is "I would like to roll now",
	and this module decides whether that is allowed and what came out.

	Auto-roll is also server-paced. The client toggles a flag; the loop that
	actually fires the rolls lives here and obeys the same cooldown as a manual
	roll, so auto-roll is a convenience rather than a rate advantage.
]]

local Players = game:GetService("Players")

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Config = require(Shared.Config)
local Species = require(Shared.Species)
local RollEngine = require(Shared.RollEngine)
local Format = require(Shared.Format)

local InventoryService = require(script.Parent.InventoryService)
local LuckService = require(script.Parent.LuckService)
local RateLimit = require(script.Parent.Parent.Util.RateLimit)
local Log = require(script.Parent.Parent.Util.Log)

local RollService = {}

local rng = Random.new()
local random = function()
	return rng:NextNumber()
end

-- lastRoll[userId] = os.clock() of the last accepted roll
local lastRoll: { [number]: number } = {}
local autoRolling: { [number]: boolean } = {}

local ctx

function RollService.init(dependencies)
	ctx = dependencies
end

local function updateLeaderstats(player: Player, profile: any)
	local stats = player:FindFirstChild("leaderstats")
	if not stats then
		return
	end

	local coins = stats:FindFirstChild("Coins")
	if coins then
		coins.Value = Format.abbreviate(profile.coins)
	end

	local level = stats:FindFirstChild("Level")
	if level then
		level.Value = profile.level
	end

	local rarest = stats:FindFirstChild("Rarest")
	if rarest then
		rarest.Value = profile.best and Format.rarity(profile.best.rarity) or "-"
	end
end

RollService.updateLeaderstats = updateLeaderstats

--[[
	Seconds the player still has to wait, or 0 if they may roll now.
]]
function RollService.remainingCooldown(player: Player, profile: any): number
	local stats = LuckService.compute(player, profile)
	local last = lastRoll[player.UserId]
	if not last then
		return 0
	end

	local elapsed = os.clock() - last
	local remaining = stats.cooldown - Config.Roll.CooldownGrace - elapsed
	return math.max(0, remaining)
end

--[[
	Perform one roll for a player, assuming the cooldown has already been
	checked. Returns the result, or nil if the roll could not happen.
]]
function RollService.performRoll(player: Player): any?
	local profile = ctx.dataService.get(player)
	if not profile then
		return nil
	end

	if LuckService.pruneEffects(profile) then
		ctx.dataService.markDirty(player)
	end

	local stats = LuckService.compute(player, profile)

	local result = RollEngine.roll(random, {
		luck = stats.luck,
		variantLuck = stats.variantLuck,
		coinMult = stats.coinMult,
		xpMult = stats.xpMult,
	})

	lastRoll[player.UserId] = os.clock()

	local newSpecies, newVariant = InventoryService.add(profile, result.speciesId, result.variantKey, 1)

	profile.rolls += 1
	profile.coins += result.coins
	profile.lifetimeCoins += result.coins
	local levelsGained = LuckService.awardXp(profile, result.xp)

	-- Personal best is tracked on effective rarity, so a shiny common can beat a
	-- plain rare -- which is the whole point of variants.
	local isRecord = false
	if not profile.best or result.effectiveRarity > profile.best.rarity then
		profile.best = {
			speciesId = result.speciesId,
			variantKey = result.variantKey,
			rarity = result.effectiveRarity,
			at = os.time(),
		}
		isRecord = true
	end

	ctx.dataService.markDirty(player)
	updateLeaderstats(player, profile)

	if isRecord then
		ctx.leaderboardService.submit(player, profile)
	end

	local payload = {
		speciesId = result.speciesId,
		name = result.name,
		tier = result.tier,
		tierIndex = result.tierIndex,
		variantKey = result.variantKey,
		rarity = result.rarity,
		effectiveRarity = result.effectiveRarity,
		coins = result.coins,
		xp = result.xp,
		luck = stats.luck,
		newSpecies = newSpecies,
		newVariant = newVariant and not newSpecies,
		isRecord = isRecord,
		levelsGained = levelsGained,
		rolls = profile.rolls,
	}

	ctx.remotes.RollResult:FireClient(player, payload)

	if levelsGained > 0 then
		ctx.notify(player, `Trainer level {profile.level}!`, "success")
	end

	local shouldAnnounce = result.tierIndex >= Config.Announce.MinTierIndex
		or (Config.Announce.AlwaysAnnounceVariants and result.variantKey ~= "")

	if shouldAnnounce then
		RollService.announce(player, result)
	end

	return payload
end

function RollService.announce(player: Player, result: any)
	local species = Species.byId[result.speciesId]
	if not species then
		return
	end

	local payload = {
		playerName = player.DisplayName,
		userId = player.UserId,
		speciesId = result.speciesId,
		name = result.name,
		tier = result.tier,
		tierIndex = result.tierIndex,
		variantKey = result.variantKey,
		rarity = result.effectiveRarity,
	}

	for _, other in Players:GetPlayers() do
		local otherProfile = ctx.dataService.get(other)
		local muted = otherProfile and otherProfile.settings.hideOthersAnnouncements and other ~= player
		if not muted then
			ctx.remotes.Announce:FireClient(other, payload)
		end
	end

	Log.info(
		"Roll",
		"%s found %s %s (%s)",
		player.Name,
		RollEngine.variantDisplayName(result.variantKey),
		result.name,
		Format.rarity(result.effectiveRarity)
	)
end

--[[
	Handle a roll request from a client.
]]
function RollService.requestRoll(player: Player)
	if not RateLimit.check(player, "roll", Config.Roll.MaxRequestsPerSecond, Config.Roll.MaxRequestsPerSecond) then
		return
	end

	local profile = ctx.dataService.get(player)
	if not profile then
		return
	end

	if RollService.remainingCooldown(player, profile) > 0 then
		-- Almost always a client that fired a frame early. Silently ignored;
		-- the client's own cooldown bar keeps it honest.
		return
	end

	RollService.performRoll(player)
end

function RollService.setAutoRoll(player: Player, enabled: boolean)
	if not RateLimit.check(player, "autoroll", 2, 4) then
		return
	end

	local profile = ctx.dataService.get(player)
	if not profile then
		return
	end

	local stats = LuckService.compute(player, profile)
	if enabled and not stats.autoRoll then
		ctx.notify(player, `Auto-roll unlocks at trainer level {Config.Roll.AutoRollLevel}.`, "error")
		return
	end

	profile.settings.autoRoll = enabled and true or false
	autoRolling[player.UserId] = profile.settings.autoRoll
	ctx.dataService.markDirty(player)

	if profile.settings.autoRoll then
		RollService.startAutoLoop(player)
	end
end

--[[
	One loop per auto-rolling player. It exits as soon as the flag clears, the
	profile goes away or the player leaves, so there is never more than one live
	loop per player.
]]
function RollService.startAutoLoop(player: Player)
	task.spawn(function()
		while autoRolling[player.UserId] and player.Parent do
			local profile = ctx.dataService.get(player)
			if not profile or not profile.settings.autoRoll then
				break
			end

			local wait = RollService.remainingCooldown(player, profile)
			if wait > 0 then
				task.wait(wait)
			else
				RollService.performRoll(player)
				local stats = LuckService.compute(player, profile)
				task.wait(stats.cooldown)
			end
		end

		autoRolling[player.UserId] = nil
	end)
end

function RollService.start()
	ctx.remotes.RequestRoll.OnServerEvent:Connect(function(player)
		RollService.requestRoll(player)
	end)

	ctx.remotes.SetAutoRoll.OnServerEvent:Connect(function(player, enabled)
		if type(enabled) ~= "boolean" then
			return
		end
		RollService.setAutoRoll(player, enabled)
	end)

	-- Resume auto-roll for players who had it on when they last logged out.
	ctx.dataService.Loaded:Connect(function(player, profile)
		if profile.settings.autoRoll then
			local stats = LuckService.compute(player, profile)
			if stats.autoRoll then
				autoRolling[player.UserId] = true
				RollService.startAutoLoop(player)
			else
				profile.settings.autoRoll = false
			end
		end
	end)

	Players.PlayerRemoving:Connect(function(player)
		lastRoll[player.UserId] = nil
		autoRolling[player.UserId] = nil
	end)
end

return RollService
