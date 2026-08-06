--!nonstrict
--[[
	Inventory
	The bag: every creature the player owns, with counts, plus bulk-selling and
	buddy equipping.

	The grid is rebuilt from scratch on each render rather than diffed. A full
	collection is a few hundred tiles, the panel is only rendered while it is
	open, and rebuilding removes a whole class of stale-tile bugs. If you extend
	this to thousands of entries, that trade stops paying and you will want
	virtualisation.
]]

local ReplicatedStorage = game:GetService("ReplicatedStorage")
local Shared = ReplicatedStorage:WaitForChild("PokeRNG")

local Format = require(Shared.Format)
local Rarity = require(Shared.Rarity)
local Species = require(Shared.Species)
local RollEngine = require(Shared.RollEngine)

local Create = require(script.Parent.Create)
local Theme = require(script.Parent.Theme)
local Window = require(script.Parent.Window)
local State = require(script.Parent.Parent.State)

local Inventory = {}

local window
local grid
local actions
local sortMode = "rarity"

local SORTS = {
	{ id = "rarity", label = "Rarity" },
	{ id = "name", label = "Name" },
	{ id = "count", label = "Count" },
	{ id = "dex", label = "Dex" },
}

local function tile(entry, parent: Instance, order: number)
	local species = Species.byId[entry.speciesId]
	if not species then
		return
	end

	local tier = Rarity.get(species.tier)
	local color = Theme.rarityColor(species.tier)
	local glow = Theme.rarityGlow(species.tier)

	local snapshot = State.current
	local isBuddy = snapshot
		and snapshot.buddy
		and snapshot.buddy.speciesId == entry.speciesId
		and (snapshot.buddy.variantKey or "") == entry.variantKey

	local button = Theme.button({
		LayoutOrder = order,
		BackgroundColor3 = Theme.color.panelAlt,
		Text = "",
		AutoButtonColor = false,
		ZIndex = 22,
		Parent = parent,
	}, function()
		actions.equip(entry.speciesId, entry.variantKey)
	end)

	-- Rarity is carried by a colour bar rather than the tile background, so the
	-- text stays readable at every tier.
	Create("Frame", {
		Size = UDim2.new(1, 0, 0, 4),
		BackgroundColor3 = color,
		BorderSizePixel = 0,
		ZIndex = 23,
		Parent = button,
		Theme.corner(4),
	})

	local variantName = RollEngine.variantDisplayName(entry.variantKey)
	local title = variantName ~= "" and `{variantName} {species.name}` or species.name

	Theme.label({
		Text = title,
		Font = Theme.font.heading,
		TextSize = 13,
		TextColor3 = variantName ~= "" and glow or Theme.color.text,
		TextTruncate = Enum.TextTruncate.AtEnd,
		Position = UDim2.fromOffset(8, 10),
		Size = UDim2.new(1, -16, 0, 16),
		ZIndex = 23,
		Parent = button,
	})

	Theme.label({
		Text = tier.name,
		TextSize = 11,
		TextColor3 = color,
		Position = UDim2.fromOffset(8, 28),
		Size = UDim2.new(1, -16, 0, 14),
		ZIndex = 23,
		Parent = button,
	})

	local rarity = RollEngine.speciesRarity(entry.speciesId, 1) * RollEngine.variantRarityMult(entry.variantKey)
	Theme.label({
		Text = Format.rarity(rarity),
		TextSize = 11,
		TextColor3 = Theme.color.subtext,
		Position = UDim2.fromOffset(8, 44),
		Size = UDim2.new(1, -16, 0, 14),
		ZIndex = 23,
		Parent = button,
	})

	Theme.label({
		Text = `x{Format.abbreviate(entry.count)}`,
		Font = Theme.font.heading,
		TextSize = 13,
		TextColor3 = Theme.color.text,
		TextXAlignment = Enum.TextXAlignment.Right,
		AnchorPoint = Vector2.new(1, 1),
		Position = UDim2.new(1, -8, 1, -6),
		Size = UDim2.fromOffset(60, 16),
		ZIndex = 23,
		Parent = button,
	})

	if isBuddy then
		Theme.stroke(Theme.color.success, 2).Parent = button
		Theme.label({
			Text = "BUDDY",
			Font = Theme.font.heading,
			TextSize = 10,
			TextColor3 = Theme.color.success,
			AnchorPoint = Vector2.new(0, 1),
			Position = UDim2.new(0, 8, 1, -6),
			Size = UDim2.fromOffset(60, 14),
			ZIndex = 23,
			Parent = button,
		})
	end
end

function Inventory.build(parent: Instance, handlers)
	actions = handlers
	window = Window.new(parent, "Bag", "Click a creature to make it your buddy")

	local toolbar = Create("Frame", {
		Size = UDim2.new(1, -24, 0, 36),
		Position = UDim2.fromOffset(12, 8),
		BackgroundTransparency = 1,
		ZIndex = 21,
		Parent = window.content,
		Theme.listLayout(6, Enum.FillDirection.Horizontal),
	})

	Theme.label({
		Text = "Sort",
		TextSize = 13,
		TextColor3 = Theme.color.subtext,
		Size = UDim2.fromOffset(34, 32),
		LayoutOrder = 0,
		ZIndex = 22,
		Parent = toolbar,
	})

	local sortButtons = {}
	for order, sort in SORTS do
		local button
		button = Theme.button({
			Text = sort.label,
			TextSize = 12,
			Size = UDim2.fromOffset(64, 30),
			LayoutOrder = order,
			BackgroundColor3 = Theme.color.panelAlt,
			ZIndex = 22,
			Parent = toolbar,
		}, function()
			sortMode = sort.id
			for id, other in sortButtons do
				other.TextColor3 = id == sort.id and Theme.color.accent or Theme.color.text
			end
			Inventory.render()
		end)
		sortButtons[sort.id] = button
		if sort.id == sortMode then
			button.TextColor3 = Theme.color.accent
		end
	end

	Theme.button({
		Text = "SELL DUPLICATES",
		TextSize = 12,
		Size = UDim2.fromOffset(150, 30),
		LayoutOrder = 90,
		BackgroundColor3 = Theme.color.accentDark,
		ZIndex = 22,
		Parent = toolbar,
	}, function()
		actions.sell(1)
	end)

	Theme.button({
		Text = "UNEQUIP",
		TextSize = 12,
		Size = UDim2.fromOffset(90, 30),
		LayoutOrder = 91,
		BackgroundColor3 = Theme.color.panelHi,
		ZIndex = 22,
		Parent = toolbar,
	}, function()
		actions.equip(nil, nil)
	end)

	local scroller = Create("ScrollingFrame", {
		Position = UDim2.fromOffset(12, 50),
		Size = UDim2.new(1, -24, 1, -62),
		BackgroundTransparency = 1,
		BorderSizePixel = 0,
		CanvasSize = UDim2.new(),
		ScrollBarThickness = 6,
		ScrollBarImageColor3 = Theme.color.stroke,
		ZIndex = 21,
		Parent = window.content,
	})

	grid = Theme.gridLayout(UDim2.fromOffset(150, 74), 8)
	grid.Parent = scroller
	Theme.autoCanvas(scroller, grid)

	window.onOpen = function()
		Inventory.render()
	end

	return window
end

function Inventory.render()
	if not window or not window.visible then
		return
	end

	local snapshot = State.current
	if not snapshot then
		return
	end

	local parent = grid.Parent
	for _, child in parent:GetChildren() do
		if child:IsA("GuiButton") then
			child:Destroy()
		end
	end

	local entries = table.clone(snapshot.inventory)

	table.sort(entries, function(a, b)
		if sortMode == "name" then
			local nameA = Species.byId[a.speciesId]
			local nameB = Species.byId[b.speciesId]
			return (nameA and nameA.name or "") < (nameB and nameB.name or "")
		elseif sortMode == "count" then
			if a.count ~= b.count then
				return a.count > b.count
			end
			return a.speciesId < b.speciesId
		elseif sortMode == "dex" then
			if a.speciesId ~= b.speciesId then
				return a.speciesId < b.speciesId
			end
			return a.variantKey < b.variantKey
		end

		local rarityA = RollEngine.speciesRarity(a.speciesId, 1) * RollEngine.variantRarityMult(a.variantKey)
		local rarityB = RollEngine.speciesRarity(b.speciesId, 1) * RollEngine.variantRarityMult(b.variantKey)
		if rarityA ~= rarityB then
			return rarityA > rarityB
		end
		return a.speciesId < b.speciesId
	end)

	for order, entry in entries do
		tile(entry, parent, order)
	end

	local owned = 0
	for _, entry in entries do
		owned += entry.count
	end
	window:setSubtitle(`{Format.comma(owned)} creatures · {#entries} unique forms · click one to equip it`)
end

function Inventory.toggle()
	if window then
		window:toggle()
	end
end

return Inventory
