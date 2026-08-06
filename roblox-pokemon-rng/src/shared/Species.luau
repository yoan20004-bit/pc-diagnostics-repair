--!strict
--[[
	Species
	The creature roster, written as compact rows and expanded into structs at
	require time.

	Row format: { dexNumber, name, tierId, type1, type2? , weight? }

	`weight` is optional and defaults to 1. It only affects how likely this
	species is *within* its tier -- a weight of 2 makes it twice as likely as a
	weight-1 species in the same tier. The tier's own rarity is untouched.

	Adding a species is a one-line change. See docs/ADDING_CONTENT.md.
]]

local Rarity = require(script.Parent.Rarity)

export type Species = {
	id: number,
	name: string,
	tier: string,
	tierIndex: number,
	types: { string },
	weight: number,
}

local rows: { { any } } = {
	-- Kanto starters and their lines
	{ 1, "Bulbasaur", "rare", "Grass", "Poison" },
	{ 2, "Ivysaur", "epic", "Grass", "Poison" },
	{ 3, "Venusaur", "mythic", "Grass", "Poison" },
	{ 4, "Charmander", "rare", "Fire" },
	{ 5, "Charmeleon", "epic", "Fire" },
	{ 6, "Charizard", "legendary", "Fire", "Flying" },
	{ 7, "Squirtle", "rare", "Water" },
	{ 8, "Wartortle", "epic", "Water" },
	{ 9, "Blastoise", "mythic", "Water" },

	-- Early routes
	{ 10, "Caterpie", "common", "Bug" },
	{ 11, "Metapod", "common", "Bug" },
	{ 12, "Butterfree", "uncommon", "Bug", "Flying" },
	{ 13, "Weedle", "common", "Bug", "Poison" },
	{ 14, "Kakuna", "common", "Bug", "Poison" },
	{ 15, "Beedrill", "uncommon", "Bug", "Poison" },
	{ 16, "Pidgey", "common", "Normal", "Flying" },
	{ 17, "Pidgeotto", "common", "Normal", "Flying" },
	{ 18, "Pidgeot", "uncommon", "Normal", "Flying" },
	{ 19, "Rattata", "common", "Normal" },
	{ 20, "Raticate", "common", "Normal" },
	{ 21, "Spearow", "common", "Normal", "Flying" },
	{ 22, "Fearow", "uncommon", "Normal", "Flying" },
	{ 23, "Ekans", "common", "Poison" },
	{ 24, "Arbok", "uncommon", "Poison" },
	{ 25, "Pikachu", "rare", "Electric", nil, 3 },
	{ 26, "Raichu", "epic", "Electric" },
	{ 27, "Sandshrew", "common", "Ground" },
	{ 28, "Sandslash", "uncommon", "Ground" },
	{ 29, "Nidoran F", "common", "Poison" },
	{ 30, "Nidorina", "common", "Poison" },
	{ 31, "Nidoqueen", "uncommon", "Poison", "Ground" },
	{ 32, "Nidoran M", "common", "Poison" },
	{ 33, "Nidorino", "common", "Poison" },
	{ 34, "Nidoking", "uncommon", "Poison", "Ground" },
	{ 35, "Clefairy", "uncommon", "Normal" },
	{ 36, "Clefable", "rare", "Normal" },
	{ 37, "Vulpix", "common", "Fire" },
	{ 38, "Ninetales", "rare", "Fire" },
	{ 39, "Jigglypuff", "common", "Normal" },
	{ 40, "Wigglytuff", "uncommon", "Normal" },
	{ 41, "Zubat", "common", "Poison", "Flying" },
	{ 42, "Golbat", "common", "Poison", "Flying" },
	{ 43, "Oddish", "common", "Grass", "Poison" },
	{ 44, "Gloom", "common", "Grass", "Poison" },
	{ 45, "Vileplume", "uncommon", "Grass", "Poison" },
	{ 46, "Paras", "common", "Bug", "Grass" },
	{ 47, "Parasect", "common", "Bug", "Grass" },
	{ 48, "Venonat", "common", "Bug", "Poison" },
	{ 49, "Venomoth", "uncommon", "Bug", "Poison" },
	{ 50, "Diglett", "common", "Ground" },
	{ 51, "Dugtrio", "uncommon", "Ground" },
	{ 52, "Meowth", "common", "Normal" },
	{ 53, "Persian", "uncommon", "Normal" },
	{ 54, "Psyduck", "common", "Water" },
	{ 55, "Golduck", "uncommon", "Water" },
	{ 56, "Mankey", "common", "Fighting" },
	{ 57, "Primeape", "uncommon", "Fighting" },
	{ 58, "Growlithe", "uncommon", "Fire" },
	{ 59, "Arcanine", "epic", "Fire" },
	{ 60, "Poliwag", "common", "Water" },
	{ 61, "Poliwhirl", "common", "Water" },
	{ 62, "Poliwrath", "uncommon", "Water", "Fighting" },
	{ 63, "Abra", "common", "Psychic" },
	{ 64, "Kadabra", "uncommon", "Psychic" },
	{ 65, "Alakazam", "epic", "Psychic" },
	{ 66, "Machop", "common", "Fighting" },
	{ 67, "Machoke", "uncommon", "Fighting" },
	{ 68, "Machamp", "epic", "Fighting" },
	{ 69, "Bellsprout", "common", "Grass", "Poison" },
	{ 70, "Weepinbell", "common", "Grass", "Poison" },
	{ 71, "Victreebel", "uncommon", "Grass", "Poison" },
	{ 72, "Tentacool", "common", "Water", "Poison" },
	{ 73, "Tentacruel", "uncommon", "Water", "Poison" },
	{ 74, "Geodude", "common", "Rock", "Ground" },
	{ 75, "Graveler", "common", "Rock", "Ground" },
	{ 76, "Golem", "uncommon", "Rock", "Ground" },
	{ 77, "Ponyta", "common", "Fire" },
	{ 78, "Rapidash", "uncommon", "Fire" },
	{ 79, "Slowpoke", "common", "Water", "Psychic" },
	{ 80, "Slowbro", "uncommon", "Water", "Psychic" },
	{ 81, "Magnemite", "common", "Electric" },
	{ 82, "Magneton", "uncommon", "Electric" },
	{ 83, "Farfetchd", "rare", "Normal", "Flying" },
	{ 84, "Doduo", "common", "Normal", "Flying" },
	{ 85, "Dodrio", "uncommon", "Normal", "Flying" },
	{ 86, "Seel", "common", "Water" },
	{ 87, "Dewgong", "uncommon", "Water", "Ice" },
	{ 88, "Grimer", "common", "Poison" },
	{ 89, "Muk", "uncommon", "Poison" },
	{ 90, "Shellder", "common", "Water" },
	{ 91, "Cloyster", "uncommon", "Water", "Ice" },
	{ 92, "Gastly", "uncommon", "Ghost", "Poison" },
	{ 93, "Haunter", "rare", "Ghost", "Poison" },
	{ 94, "Gengar", "epic", "Ghost", "Poison" },
	{ 95, "Onix", "uncommon", "Rock", "Ground" },
	{ 96, "Drowzee", "common", "Psychic" },
	{ 97, "Hypno", "uncommon", "Psychic" },
	{ 98, "Krabby", "common", "Water" },
	{ 99, "Kingler", "uncommon", "Water" },
	{ 100, "Voltorb", "common", "Electric" },
	{ 101, "Electrode", "uncommon", "Electric" },
	{ 102, "Exeggcute", "common", "Grass", "Psychic" },
	{ 103, "Exeggutor", "uncommon", "Grass", "Psychic" },
	{ 104, "Cubone", "common", "Ground" },
	{ 105, "Marowak", "uncommon", "Ground" },
	{ 106, "Hitmonlee", "rare", "Fighting" },
	{ 107, "Hitmonchan", "rare", "Fighting" },
	{ 108, "Lickitung", "rare", "Normal" },
	{ 109, "Koffing", "common", "Poison" },
	{ 110, "Weezing", "uncommon", "Poison" },
	{ 111, "Rhyhorn", "common", "Ground", "Rock" },
	{ 112, "Rhydon", "uncommon", "Ground", "Rock" },
	{ 113, "Chansey", "epic", "Normal" },
	{ 114, "Tangela", "rare", "Grass" },
	{ 115, "Kangaskhan", "epic", "Normal" },
	{ 116, "Horsea", "common", "Water" },
	{ 117, "Seadra", "uncommon", "Water" },
	{ 118, "Goldeen", "common", "Water" },
	{ 119, "Seaking", "uncommon", "Water" },
	{ 120, "Staryu", "common", "Water" },
	{ 121, "Starmie", "uncommon", "Water", "Psychic" },
	{ 122, "Mr Mime", "rare", "Psychic" },
	{ 123, "Scyther", "epic", "Bug", "Flying" },
	{ 124, "Jynx", "rare", "Ice", "Psychic" },
	{ 125, "Electabuzz", "rare", "Electric" },
	{ 126, "Magmar", "rare", "Fire" },
	{ 127, "Pinsir", "epic", "Bug" },
	{ 128, "Tauros", "rare", "Normal" },
	{ 129, "Magikarp", "common", "Water", nil, 4 },
	{ 130, "Gyarados", "epic", "Water", "Flying" },
	{ 131, "Lapras", "mythic", "Water", "Ice" },
	{ 132, "Ditto", "mythic", "Normal" },
	{ 133, "Eevee", "rare", "Normal", nil, 2 },
	{ 134, "Vaporeon", "epic", "Water" },
	{ 135, "Jolteon", "epic", "Electric" },
	{ 136, "Flareon", "epic", "Fire" },
	{ 137, "Porygon", "epic", "Normal" },
	{ 138, "Omanyte", "rare", "Rock", "Water" },
	{ 139, "Omastar", "epic", "Rock", "Water" },
	{ 140, "Kabuto", "rare", "Rock", "Water" },
	{ 141, "Kabutops", "epic", "Rock", "Water" },
	{ 142, "Aerodactyl", "mythic", "Rock", "Flying" },
	{ 143, "Snorlax", "mythic", "Normal" },
	{ 144, "Articuno", "legendary", "Ice", "Flying" },
	{ 145, "Zapdos", "legendary", "Electric", "Flying" },
	{ 146, "Moltres", "legendary", "Fire", "Flying" },
	{ 147, "Dratini", "epic", "Dragon" },
	{ 148, "Dragonair", "mythic", "Dragon" },
	{ 149, "Dragonite", "ultra", "Dragon", "Flying" },
	{ 150, "Mewtwo", "master", "Psychic" },
	{ 151, "Mew", "ancient", "Psychic" },

	-- The one-of-a-kind Celestial. Nothing else sits in this tier.
	{ 152, "MissingNo", "celestial", "Normal", "Ghost" },
}

local Species = {}

Species.list = {} :: { Species }
Species.byId = {} :: { [number]: Species }
Species.byTier = {} :: { [string]: { Species } }
Species.tierWeight = {} :: { [string]: number }
Species.byType = {} :: { [string]: { Species } }
Species.typeList = {} :: { string }

for _, row in rows do
	local tierId = row[3] :: string
	local tier = Rarity.get(tierId)

	local types = {}
	if row[4] then
		table.insert(types, row[4] :: string)
	end
	if row[5] then
		table.insert(types, row[5] :: string)
	end

	local entry: Species = {
		id = row[1] :: number,
		name = row[2] :: string,
		tier = tierId,
		tierIndex = tier.index,
		types = types,
		weight = (row[6] :: number?) or 1,
	}

	assert(Species.byId[entry.id] == nil, `duplicate species id {entry.id}`)
	Species.byId[entry.id] = entry
	table.insert(Species.list, entry)

	local bucket = Species.byTier[tierId]
	if not bucket then
		bucket = {}
		Species.byTier[tierId] = bucket
	end
	table.insert(bucket, entry)
	Species.tierWeight[tierId] = (Species.tierWeight[tierId] or 0) + entry.weight

	for _, typeName in types do
		local typeBucket = Species.byType[typeName]
		if not typeBucket then
			typeBucket = {}
			Species.byType[typeName] = typeBucket
			table.insert(Species.typeList, typeName)
		end
		table.insert(typeBucket, entry)
	end
end

table.sort(Species.typeList)

Species.count = #Species.list

function Species.get(id: number): Species?
	return Species.byId[id]
end

--[[
	How likely this species is once its tier has already been selected.
]]
function Species.shareOfTier(species: Species): number
	local total = Species.tierWeight[species.tier]
	if not total or total <= 0 then
		return 0
	end
	return species.weight / total
end

return Species
