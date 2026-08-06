--!nonstrict
--[[
	RewardService
	Daily login rewards and promo codes.

	The daily reward uses two separate windows on purpose: it becomes claimable
	after 20 hours but the streak only breaks after 48. A player who logs in at
	roughly the same time each day is never punished for being an hour late.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Config = require(Shared.Config)
local Codes = require(Shared.Codes)
local Upgrades = require(Shared.Upgrades)
local Format = require(Shared.Format)

local RateLimit = require(script.Parent.Parent.Util.RateLimit)

local RewardService = {}

local ctx

function RewardService.init(dependencies)
	ctx = dependencies
end

--[[
	Daily state, also sent to the client so the button can show a countdown.
]]
function RewardService.dailyStatus(profile: any)
	local now = os.time()
	local last = profile.daily.lastClaim or 0
	local elapsed = now - last

	local claimable = last == 0 or elapsed >= Config.Daily.CooldownSeconds
	local streak = profile.daily.streak or 0
	if last > 0 and elapsed >= Config.Daily.ResetSeconds then
		streak = 0
	end

	return {
		claimable = claimable,
		streak = streak,
		nextIn = claimable and 0 or (Config.Daily.CooldownSeconds - elapsed),
	}
end

function RewardService.claimDaily(player: Player)
	if not RateLimit.check(player, "daily", 1, 3) then
		return
	end

	local profile = ctx.dataService.get(player)
	if not profile then
		return
	end
	if ctx.dataService.isReadOnly(player) then
		ctx.notify(player, "Your save could not be loaded, so rewards are disabled this session.", "error")
		return
	end

	local status = RewardService.dailyStatus(profile)
	if not status.claimable then
		ctx.notify(player, `Next daily reward in {Format.duration(status.nextIn)}.`, "info")
		return
	end

	local streak = math.min(status.streak + 1, Config.Daily.MaxStreak)
	local coins = Config.Daily.BaseCoins + Config.Daily.CoinsPerStreakDay * (streak - 1)

	profile.coins += coins
	profile.lifetimeCoins += coins
	profile.daily.lastClaim = os.time()
	profile.daily.streak = streak

	local potionId = Config.Daily.StreakPotions[streak]
	if potionId and Upgrades.potionsById[potionId] then
		profile.potions[potionId] = (profile.potions[potionId] or 0) + 1
	end

	ctx.dataService.markDirty(player)
	ctx.rollService.updateLeaderstats(player, profile)

	local message = `Day {streak} reward: {Format.comma(coins)} coins`
	if potionId then
		message ..= ` and a {Upgrades.potionsById[potionId].name}`
	end
	ctx.notify(player, message .. ".", "success")
end

function RewardService.redeemCode(player: Player, input: string)
	if not RateLimit.check(player, "code", 1, 5) then
		return
	end

	local profile = ctx.dataService.get(player)
	if not profile then
		return
	end
	if ctx.dataService.isReadOnly(player) then
		ctx.notify(player, "Your save could not be loaded, so codes are disabled this session.", "error")
		return
	end

	-- Long inputs are never real codes, and are not worth normalising.
	if #input > 64 then
		return
	end

	local normalised = Codes.normalise(input)
	local entry = Codes.byCode[normalised]

	if not entry then
		ctx.notify(player, "That code isn't valid.", "error")
		return
	end

	if not Codes.isActive(entry, os.time()) then
		ctx.notify(player, "That code has expired.", "error")
		return
	end

	if profile.redeemedCodes[normalised] then
		ctx.notify(player, "You've already used that code.", "error")
		return
	end

	profile.redeemedCodes[normalised] = true

	local rewards = {}
	if entry.coins then
		profile.coins += entry.coins
		profile.lifetimeCoins += entry.coins
		table.insert(rewards, `{Format.comma(entry.coins)} coins`)
	end

	if entry.potions then
		for _, potionId in entry.potions do
			local potion = Upgrades.potionsById[potionId]
			if potion then
				profile.potions[potionId] = (profile.potions[potionId] or 0) + 1
				table.insert(rewards, potion.name)
			end
		end
	end

	ctx.dataService.markDirty(player)
	ctx.rollService.updateLeaderstats(player, profile)

	ctx.notify(player, `Code redeemed: {table.concat(rewards, ", ")}.`, "success")
end

function RewardService.start()
	ctx.remotes.ClaimDaily.OnServerEvent:Connect(function(player)
		RewardService.claimDaily(player)
	end)

	ctx.remotes.RedeemCode.OnServerEvent:Connect(function(player, code)
		if type(code) ~= "string" then
			return
		end
		RewardService.redeemCode(player, code)
	end)
end

return RewardService
