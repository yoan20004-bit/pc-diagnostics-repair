--!strict
--[[
	Rarity
	The tier ladder. Tier 1 (Common) is the fallback and has no rarity of its
	own -- it is whatever probability is left over once every rarer tier has
	failed its roll.

	Tiers are ordered from most common to rarest. RollEngine walks this list
	backwards so the rarest tier always gets first refusal.
]]

export type Tier = {
	index: number,
	id: string,
	name: string,
	rarity: number, -- 1 in N at 1x luck
	color: { number }, -- RGB
	glow: { number }, -- RGB, used for the reveal flash and particles
}

local Rarity = {}

Rarity.tiers = {
	{ index = 1, id = "common", name = "Common", rarity = 1, color = { 168, 176, 188 }, glow = { 210, 216, 226 } },
	{ index = 2, id = "uncommon", name = "Uncommon", rarity = 8, color = { 106, 196, 122 }, glow = { 148, 240, 164 } },
	{ index = 3, id = "rare", name = "Rare", rarity = 45, color = { 78, 152, 236 }, glow = { 128, 194, 255 } },
	{ index = 4, id = "epic", name = "Epic", rarity = 250, color = { 158, 96, 226 }, glow = { 198, 140, 255 } },
	{ index = 5, id = "mythic", name = "Mythic", rarity = 1500, color = { 226, 84, 152 }, glow = { 255, 132, 190 } },
	{ index = 6, id = "legendary", name = "Legendary", rarity = 12000, color = { 244, 168, 40 }, glow = { 255, 214, 96 } },
	{ index = 7, id = "ultra", name = "Ultra", rarity = 90000, color = { 236, 72, 72 }, glow = { 255, 130, 118 } },
	{ index = 8, id = "master", name = "Master", rarity = 750000, color = { 64, 224, 208 }, glow = { 150, 255, 244 } },
	{ index = 9, id = "ancient", name = "Ancient", rarity = 8000000, color = { 250, 240, 210 }, glow = { 255, 252, 236 } },
	{ index = 10, id = "celestial", name = "Celestial", rarity = 100000000, color = { 132, 0, 255 }, glow = { 214, 128, 255 } },
} :: { Tier }

Rarity.byId = {} :: { [string]: Tier }
for _, tier in Rarity.tiers do
	Rarity.byId[tier.id] = tier
end

Rarity.count = #Rarity.tiers

function Rarity.get(id: string): Tier
	local tier = Rarity.byId[id]
	assert(tier, `unknown rarity tier "{id}"`)
	return tier
end

function Rarity.byIndex(index: number): Tier
	local tier = Rarity.tiers[index]
	assert(tier, `no rarity tier at index {index}`)
	return tier
end

--[[
	The probability of landing on `tier` at a given luck multiplier.

	The roll walks the ladder from rarest to most common and stops at the first
	success, so a tier's real chance is its own chance times the chance that
	every rarer tier missed.
]]
function Rarity.tierChance(tierIndex: number, luck: number): number
	local missedRarer = 1
	for i = Rarity.count, tierIndex + 1, -1 do
		local chance = math.min(1, luck / Rarity.tiers[i].rarity)
		missedRarer *= (1 - chance)
		if missedRarer <= 0 then
			return 0
		end
	end

	if tierIndex == 1 then
		-- Common is the leftover, not a roll of its own.
		return missedRarer
	end

	return missedRarer * math.min(1, luck / Rarity.tiers[tierIndex].rarity)
end

return Rarity
